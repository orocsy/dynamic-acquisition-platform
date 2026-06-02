import { sanitizeNavigationUrlPreview } from './navigationPolicy';
import {
  BasePageTargetController,
  mintPageTargetRef,
  type BasePageTargetControllerOptions,
  type CreatePageTargetInput,
  type NavigatePageTargetInput,
  type NavigationEffectContext,
  type NavigationEffectResult,
  type PageTargetSnapshot,
} from './pageTargetController';
import type { BrowserTargetState } from './types';

/**
 * Deterministic in-memory page target controller for unit and fixture tests, and
 * for driving the later Phase 3.4+ runtime adapter without a real browser. It
 * reuses the base state machine and opaque-ref discipline; only the navigation
 * *effect* is simulated, via an injectable planner so a test can script success,
 * an auth redirect, or a failure.
 */

export type FakeNavigationPlannerInput = {
  pageTargetRef: string;
  url: string;
  waitUntil: NavigationEffectContext['waitUntil'];
  from: BrowserTargetState;
};

export type FakeNavigationPlanner = (input: FakeNavigationPlannerInput) => NavigationEffectResult;

/** Default: a clean 200 that lands on the requested URL. */
export function defaultFakeNavigationPlanner(input: FakeNavigationPlannerInput): NavigationEffectResult {
  return { ok: true, status: 200, finalUrl: input.url };
}

export type FakePageTargetControllerOptions = BasePageTargetControllerOptions & {
  navigationPlanner?: FakeNavigationPlanner;
};

export class FakePageTargetController extends BasePageTargetController {
  readonly #planNavigation: FakeNavigationPlanner;

  constructor(options: FakePageTargetControllerOptions = {}) {
    super(options);
    this.#planNavigation = options.navigationPlanner ?? defaultFakeNavigationPlanner;
  }

  async createTarget(input: CreatePageTargetInput): Promise<PageTargetSnapshot> {
    const ref = mintPageTargetRef(this.mintRef); // throws on a non-opaque factory output
    const now = input.now ?? this.clock();
    return this.store.insertCreated({
      pageTargetRef: ref,
      runId: input.runId,
      daemonId: String(input.daemonRef.id),
      urlPreview: sanitizeNavigationUrlPreview(input.targetUrl),
      titlePreview: undefined,
      createdAt: now,
      updatedAt: now,
    });
  }

  protected async performNavigation(
    input: NavigatePageTargetInput,
    context: NavigationEffectContext,
  ): Promise<NavigationEffectResult> {
    return this.#planNavigation({
      pageTargetRef: context.pageTargetRef,
      url: input.url,
      waitUntil: context.waitUntil,
      from: context.from,
    });
  }
}
