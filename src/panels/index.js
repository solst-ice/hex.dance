/**
 * Panels are discovered from `./<name>/index.jsx`, so a panel is added by
 * adding a folder. Each module default-exports a PanelModule.
 *
 * @typedef {Object} PanelContext
 * @property {File|null} file
 * @property {import('../analysis/types.js').Analysis|null} analysis
 * @property {'idle'|'reading'|'analyzing'|'ready'|'error'} status
 *
 * @typedef {Object} PanelModule
 * @property {string} id
 * @property {string} title
 * @property {string} [description]          one plain line on what the panel is for, shown in its section header
 * @property {number} order                  ascending; ties are broken by id. 'tab' panels run group by group
 * @property {1|2|3} [group]                 'tab' panels: 1 what the file is, 2 finding things in the bytes,
 *                                            3 seeing and playing; each group is a column on wide screens
 * @property {'tab'|'dock'} placement        'tab': a collapsible section beside (or below) the hex view;
 *                                            'dock': always visible under the hex view
 * @property {(context: PanelContext) => boolean} [isAvailable]   without it, available whenever a file is open
 * @property {(context: { analysis: import('../analysis/types.js').Analysis|null }) => string|number|null} [badge]
 * @property {import('react').ComponentType} Component   takes no props; reads state through the hooks in
 *                                            src/state (useFile, useSelectionActions, useHexCursor, ...)
 */

const modules = import.meta.glob('./*/index.jsx', { eager: true })

/** @type {PanelModule[]} */
export const PANELS = Object.entries(modules)
  .map(([path, module]) => {
    const panel = module.default
    if (!panel || !panel.id || !panel.Component) {
      console.error(`Panel module ${path} does not default-export { id, Component, ... }`)
      return null
    }
    return panel
  })
  .filter(Boolean)
  .sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))

/** Panels of one placement that are available for the current file. */
export function availablePanels(placement, context) {
  return PANELS.filter(panel => {
    if ((panel.placement || 'tab') !== placement) return false
    try {
      return Boolean(panel.isAvailable ? panel.isAvailable(context) : context.file)
    } catch (err) {
      console.error(`Panel ${panel.id}: isAvailable failed`, err)
      return false
    }
  })
}

export function panelBadge(panel, analysis) {
  if (!panel.badge) return null
  try {
    const badge = panel.badge({ analysis })
    return badge === null || badge === undefined || badge === '' ? null : badge
  } catch {
    return null
  }
}
