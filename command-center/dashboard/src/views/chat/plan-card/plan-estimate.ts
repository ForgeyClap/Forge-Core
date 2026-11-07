/**
 * The estimate behind a team-job plan card (WP B3, plan §3.2 "Wanneer wordt een chat een
 * teamklus, en wat kost dat?").
 *
 * The route table is the project's model routing (route -> model + thinking effort), kept in code
 * only: the copy never names it. Minutes come from per-step bands per route. The share of the
 * 5-hour limit is only estimated when there is history from earlier jobs; without it the card says
 * "nog onbekend" instead of inventing a number.
 */

export const PLAN_ROUTES = ['quick', 'build', 'deep'] as const;
export type PlanRoute = (typeof PLAN_ROUTES)[number];

interface RouteProfile {
  readonly model: 'sonnet' | 'opus';
  readonly effort: 'low' | 'medium' | 'xhigh';
  /** Relative cost of one step on this route (a check step on the verifier route costs 1). */
  readonly units: number;
  /** Minutes per step, low and high. */
  readonly minutes: readonly [number, number];
}

/** Route -> model and effort, from the routing table (triage -> quick | build | deep, verifier after). */
export const ROUTE_PROFILE: Readonly<Record<PlanRoute, RouteProfile>> = {
  quick: { model: 'sonnet', effort: 'low', units: 1, minutes: [2, 5] },
  build: { model: 'opus', effort: 'medium', units: 3, minutes: [5, 12] },
  deep: { model: 'opus', effort: 'xhigh', units: 6, minutes: [10, 25] },
};

/** Every step is checked afterwards (verifier route: sonnet, medium). */
export const CHECK_STEP = { model: 'sonnet', effort: 'medium', units: 1, minutes: [1, 3] } as const;

export interface PlanStep {
  readonly title: string;
  /** Role as the logs name it ("Build Boss") or its slug ("build-boss"). */
  readonly role: string;
}

export interface PlanHistory {
  /** Observed share of the 5-hour limit per cost unit in earlier jobs, in percent. */
  readonly limitPctPerUnit: number;
}

export interface TeamPlan {
  readonly title: string;
  readonly route: PlanRoute;
  readonly steps: readonly PlanStep[];
  readonly history?: PlanHistory | null;
}

export interface PlanEstimate {
  readonly steps: number;
  readonly helpers: number;
  readonly units: number;
  readonly minutes: readonly [number, number];
  /** null = unknown (no earlier job of this kind). */
  readonly limitPct: readonly [number, number] | null;
}

/** Spread around the point estimate: honest about being a band, not a number. */
const LOW = 0.7;
const HIGH = 1.3;

export function estimatePlan(plan: TeamPlan): PlanEstimate {
  const profile = ROUTE_PROFILE[plan.route];
  const steps = plan.steps.length;
  const helpers = new Set(plan.steps.map((step) => step.role.trim().toLowerCase().replace(/\s+/g, '-'))).size;
  const units = steps * (profile.units + CHECK_STEP.units);
  const minutes: [number, number] = [
    steps * (profile.minutes[0] + CHECK_STEP.minutes[0]),
    steps * (profile.minutes[1] + CHECK_STEP.minutes[1]),
  ];
  const rate = plan.history?.limitPctPerUnit;
  const limitPct: [number, number] | null =
    typeof rate === 'number' && Number.isFinite(rate) && rate > 0
      ? [Math.min(100, Math.max(1, Math.round(units * rate * LOW))), Math.min(100, Math.max(1, Math.round(units * rate * HIGH)))]
      : null;
  return { steps, helpers, units, minutes, limitPct };
}
