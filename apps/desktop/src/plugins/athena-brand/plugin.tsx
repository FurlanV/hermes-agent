// The Athena brand plugin lives in src/athena with the rest of the branding, so
// joining the bundled-plugin glob takes this one re-export and no upstream edit.
// It still speaks only @hermes/plugin-sdk (plus its own branding data).
// eslint-disable-next-line no-restricted-imports
export { default } from '../../athena/brand-plugin'
