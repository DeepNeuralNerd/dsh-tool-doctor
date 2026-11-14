/**
 * Client entry point for the tool-doctor dashboard.
 * Registers the Tool Doctor section in the Settings panel.
 *
 * @module dsh-tool-doctor/client
 */

import { DoctorSection, type DoctorSectionInjected } from "./DoctorSection.tsx";
import { DoctorStore } from "./store.ts";
import { en, type NormalizerKey } from "./locales.ts";

export type { DoctorSectionInjected, DoctorSectionProps } from "./DoctorSection.tsx";
export type { NormalizerKey } from "./locales.ts";
export type {
  DoctorConfigFlags,
  DoctorErrorSource,
  DoctorState,
  DoctorStore,
  DoctorTab,
  GuidanceState,
  NormalizerRecord,
  NormalizerStats,
  StatusFilter,
} from "./store.ts";

const NS = "settings.tool-doctor";

export const inject = ["slots", "locale"];

/** Locale binding as the host exposes it: key → translated string. */
type BoundT = (key: string) => string | undefined;

interface LocaleApi {
  register?: (ns: string, dictionary: Record<string, unknown>) => void;
  bind?: (ns: string) => BoundT | undefined;
}

interface SlotMeta {
  name: string;
  id: string;
  order: number;
  label: () => string;
  inject: () => DoctorSectionInjected;
}

interface SlotsApi {
  inject?: (name: string, factory: () => void) => void;
  register?: (meta: SlotMeta, component: unknown) => void;
}

/** The client root context the host hands to `apply` (host boundary). */
export interface HostContext {
  effect?: (fn: () => void, label?: string) => void;
  locale?: LocaleApi;
  slots?: SlotsApi;
}

/**
 * Register the Tool Doctor section in the Settings navigation.
 *
 * @param ctx - Client root context.
 */
export function apply(ctx: HostContext): void {
  // Register the English dictionary. The fallback below guarantees English
  // even when the host UI locale is not English.
  const locale = ctx.locale;
  ctx.effect?.(
    () => {
      locale?.register?.(NS, { en });
    },
    "tool-doctor: copy dictionaries",
  );

  const controller = new DoctorStore();
  const boundT = ctx.locale?.bind?.(NS);
  const t = ((k: NormalizerKey) => {
    if (boundT) {
      const v = boundT(k);
      if (v && v !== k) return v;
    }
    return en[k] || k;
  }) as DoctorSectionInjected["t"];

  const injected = (): DoctorSectionInjected => ({ controller, t });

  ctx.slots?.inject?.("settings.section", () =>
    ctx.slots?.register?.(
      {
        name: "settings.section",
        id: "tool-doctor",
        order: 25,
        label: () => en.nav,
        inject: injected,
      },
      DoctorSection,
    ),
  );
}

export default { name: "tool-doctor-client", inject, apply };
