import { LocaleManager } from "@bryntum/core-enterprise";
import { venueSpokenDate } from "@/domain/labels";
import { atVenue } from "@/domain/time";
/** Public localization callbacks bypass v8's browser-local default ARIA date formatter. */
export function configureVenueAria(range: () => { startDate?: Date; endDate?: Date } | undefined) {
  LocaleManager.applyLocale({ localeName: "En", TimeAxisColumn: { ariaLabel: () => {
    const visible = range();
    return `Time axis showing ${venueSpokenDate(visible?.startDate ?? atVenue("14:30"))} to ${venueSpokenDate(visible?.endDate ?? atVenue("23:45"))}. America Chicago venue time.`;
  } }, SchedulerBase: { eventAriaLabel: (event: { name: string; startDate: Date; endDate: Date }) => `${event.name}. ${venueSpokenDate(event.startDate)} until ${venueSpokenDate(event.endDate)}. America Chicago venue time.` } });
}
