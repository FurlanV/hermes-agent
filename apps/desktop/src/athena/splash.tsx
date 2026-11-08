import logoUrl from './assets/source/sickkids-logo.svg'
import branding from './branding.json'

/**
 * The Athena empty-chat splash: the SickKids wordmark, the app name and the
 * tagline. It is a `chat.empty` contribution (brand-plugin.tsx), so cards
 * other plugins contribute to the same area, such as the Athena sign-in card,
 * render directly below it inside the same centred column.
 */
export function AthenaSplash() {
  return (
    <div
      className="pointer-events-none flex w-full min-w-0 flex-col items-center justify-center gap-3 px-0.5 py-6 text-center sm:px-6 lg:px-8"
      data-slot="athena_splash"
    >
      {/* The wordmark keeps its own colours in light mode; dark mode shows it
          reversed to white, as the SickKids blue is too dark on the navy. */}
      <img
        alt={branding.organization}
        className="h-12 w-auto select-none dark:brightness-0 dark:invert"
        draggable={false}
        src={logoUrl}
      />
      <h1 className="m-0 text-4xl font-semibold tracking-tight text-primary">{branding.display}</h1>
      <p className="m-0 leading-normal tracking-tight text-muted-foreground">{branding.tagline}</p>
    </div>
  )
}
