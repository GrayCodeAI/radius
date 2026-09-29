/**
 * Hard spend caps — the Phase 4 gate, built as pure logic.
 *
 * The gate reads: *"A hard spend cap cannot be exceeded, including under retry and partial
 * failure. Demonstrated under fault injection."* The second sentence is the whole difficulty,
 * and the reason this module exists rather than an `if (spent > cap)` at the call site:
 *
 *   - **Retries cost twice.** A provider that fails after accepting a request has already billed
 *     it. A cap counting only *successful* turns overshoots under exactly the conditions where an
 *     operator is retrying hardest.
 *   - **Partial failure splits reservation from settlement.** A crash between the two must not
 *     leak a reservation forever, nor release headroom already spent.
 *   - **Concurrent turns race.** Two in-flight turns must not both see "under cap" and together
 *     cross it. The cap is enforced at *reservation* time against committed + reserved, never
 *     recomputed from a running total at settlement.
 *
 * The invariant, stated once: **`committed + reserved` never exceeds `cap`.** Everything here
 * exists to hold that, and the tests assert it directly rather than asserting an outcome that
 * merely implies it.
 */

import { ProtocolError } from "./principal.ts";

export interface Budget {
  /** Hard ceiling in the smallest currency unit, to avoid float drift. */
  readonly capMinor: number;
  readonly currency: string;
}

export class BudgetExceededError extends Error {
  constructor(
    readonly requestedMinor: number,
    readonly committedMinor: number,
    readonly reservedMinor: number,
    readonly capMinor: number,
  ) {
    super(
      `spend cap exceeded: committing ${requestedMinor} would take committed+reserved to ` +
        `${committedMinor + reservedMinor + requestedMinor}, over the cap of ${capMinor}. ` +
        `Refusing the reservation.`,
    );
    this.name = "BudgetExceededError";
  }
}

export interface Reservation {
  readonly id: string;
  readonly principalId: string;
  /** What we set aside: the upper bound, so a partial result cannot overshoot. */
  readonly reservedMinor: number;
  readonly createdAt: number;
}

interface Tracked extends Reservation {
  settledMinor: number | null;
}

export class CostLedger {
  readonly #budget: Budget;
  readonly #committed = new Map<string, number>();
  readonly #reservations = new Map<string, Tracked>();

  constructor(budget: Budget) {
    if (!Number.isInteger(budget.capMinor) || budget.capMinor < 0) {
      throw new ProtocolError("capMinor must be a non-negative integer");
    }
    this.#budget = budget;
  }

  committedFor(principalId: string): number {
    return this.#committed.get(principalId) ?? 0;
  }

  /**
   * Headroom currently held back by *unsettled* reservations.
   *
   * A settled reservation is deliberately excluded: its money has already moved into
   * `committed`, so counting it here as well would charge for it twice and make `available()`
   * understate the budget — silently throttling an agent that still has headroom.
   */
  reservedFor(principalId: string): number {
    let total = 0;
    for (const r of this.#reservations.values()) {
      if (r.principalId === principalId && r.settledMinor === null) {
        total += r.reservedMinor;
      }
    }
    return total;
  }

  /**
   * Reserve headroom before spending.
   *
   * The check is against `committed + reserved + requested`, so two concurrent turns cannot both
   * see headroom and collectively cross the cap. Reserving the *upper* bound is what makes a
   * partial result harmless: settlement only ever moves money from reserved to committed.
   */
  reserve(
    principalId: string,
    upperBoundMinor: number,
    now: number,
  ): Reservation {
    if (!Number.isInteger(upperBoundMinor) || upperBoundMinor < 0) {
      throw new ProtocolError("upperBoundMinor must be a non-negative integer");
    }
    const committed = this.committedFor(principalId);
    const reserved = this.reservedFor(principalId);
    if (committed + reserved + upperBoundMinor > this.#budget.capMinor) {
      throw new BudgetExceededError(
        upperBoundMinor,
        committed,
        reserved,
        this.#budget.capMinor,
      );
    }
    const reservation: Tracked = {
      id: `res_${principalId}_${now}_${this.#reservations.size}`,
      principalId,
      reservedMinor: upperBoundMinor,
      createdAt: now,
      settledMinor: null,
    };
    this.#reservations.set(reservation.id, reservation);
    return reservation;
  }

  /**
   * Settle a reservation at its actual cost.
   *
   * Actual may be *less* than reserved (headroom returns to the budget) or equal. It may not be
   * more: if the real cost exceeds the bound we reserved, the cap has already been crossed, and
   * the honest thing is to say so rather than quietly over-committing.
   */
  settle(reservationId: string, actualMinor: number): number {
    const reservation = this.#reservations.get(reservationId);
    if (!reservation) {
      throw new ProtocolError(`no such reservation: ${reservationId}`);
    }
    if (reservation.settledMinor !== null) {
      // Settling twice is a retry, not an error, and must not double-charge.
      return reservation.settledMinor;
    }
    if (actualMinor < 0) {
      throw new ProtocolError("actualMinor must be non-negative");
    }
    if (actualMinor > reservation.reservedMinor) {
      throw new BudgetExceededError(
        actualMinor - reservation.reservedMinor,
        this.committedFor(reservation.principalId),
        this.reservedFor(reservation.principalId),
        this.#budget.capMinor,
      );
    }
    reservation.settledMinor = actualMinor;
    this.#committed.set(
      reservation.principalId,
      this.committedFor(reservation.principalId) + actualMinor,
    );
    return actualMinor;
  }

  /**
   * Release a reservation that never became a call.
   *
   * Distinct from `settle(0)`: a release means no money moved at all, so it must not create a
   * committed row. Without this, a crash between reserve and send would leak headroom forever and
   * the agent would stop working with budget still available.
   */
  release(reservationId: string): void {
    const reservation = this.#reservations.get(reservationId);
    if (!reservation)
      throw new ProtocolError(`no such reservation: ${reservationId}`);
    if (reservation.settledMinor === null)
      this.#reservations.delete(reservationId);
  }

  /** Headroom still spendable, accounting for in-flight reservations. */
  available(principalId: string): number {
    return Math.max(
      0,
      this.#budget.capMinor -
        this.committedFor(principalId) -
        this.reservedFor(principalId),
    );
  }

  get capMinor(): number {
    return this.#budget.capMinor;
  }

  get openReservations(): number {
    let n = 0;
    for (const r of this.#reservations.values())
      if (r.settledMinor === null) n += 1;
    return n;
  }
}
