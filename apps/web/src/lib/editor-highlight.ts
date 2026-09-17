import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { EditorView } from '@codemirror/view'
import type { Extension } from '@codemirror/state'
import { tags as t } from '@lezer/highlight'
import { githubLightStyle, githubDarkStyle } from '@uiw/codemirror-theme-github'
import { vscodeLightStyle, vscodeDarkStyle } from '@uiw/codemirror-theme-vscode'
import { draculaDarkStyle } from '@uiw/codemirror-theme-dracula'
import { nordDarkStyle } from '@uiw/codemirror-theme-nord'
import { tokyoNightStyle } from '@uiw/codemirror-theme-tokyo-night'
import { quietlightStyle } from '@uiw/codemirror-theme-quietlight'
import { solarizedLightStyle } from '@uiw/codemirror-theme-solarized'
import { tokyoNightDayStyle } from '@uiw/codemirror-theme-tokyo-night-day'
import { xcodeLightStyle } from '@uiw/codemirror-theme-xcode'
import type { EditorThemeId } from './editor-theme-options'

// Preserve YARC's original variable-based palette as the default option.
const highlightStyle = HighlightStyle.define([
  { tag: [t.keyword, t.modifier, t.operatorKeyword], color: 'var(--color-primary)' },
  { tag: [t.controlKeyword, t.moduleKeyword], color: 'var(--color-primary)', fontWeight: '600' },
  { tag: [t.string, t.special(t.string)], color: 'var(--color-success)' },
  { tag: [t.number, t.bool, t.null, t.atom], color: 'var(--color-warning)' },
  { tag: [t.comment, t.lineComment, t.blockComment], color: 'var(--color-text-muted)', fontStyle: 'italic' },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: 'var(--color-primary-hover)' },
  { tag: [t.typeName, t.className, t.namespace], color: 'var(--color-primary-hover)' },
  { tag: [t.propertyName, t.attributeName], color: 'var(--color-text)' },
  { tag: [t.tagName], color: 'var(--color-error)' },
  { tag: [t.heading], color: 'var(--color-primary)', fontWeight: '600' },
  { tag: [t.link, t.url], color: 'var(--color-primary)', textDecoration: 'underline' },
  { tag: [t.emphasis], fontStyle: 'italic' },
  { tag: [t.strong], fontWeight: '700' },
  { tag: [t.meta, t.processingInstruction], color: 'var(--color-text-secondary)' },
  { tag: [t.variableName], color: 'var(--color-primary-hover)' },
  { tag: [t.operator, t.punctuation], color: 'var(--color-text-secondary)' },
  { tag: [t.bracket, t.squareBracket, t.paren, t.brace], color: 'var(--color-warning)' },
  { tag: [t.invalid], color: 'var(--color-error)' },
])

// Import only syntax rules, never the packages' full EditorView themes.
// Token backgrounds are excluded too, so switching palettes changes text only.
const syntaxOnly = (styles: Parameters<typeof HighlightStyle.define>[0]) => HighlightStyle.define(
  styles.map(({ tag, color, fontStyle, fontWeight, textDecoration }) => ({
    tag, color, fontStyle, fontWeight, textDecoration,
  })),
)

export const editorHighlightStyles: Record<EditorThemeId, HighlightStyle> = {
  default: highlightStyle,
  'vscode-light': syntaxOnly(vscodeLightStyle),
  quietlight: syntaxOnly(quietlightStyle),
  'solarized-light': syntaxOnly(solarizedLightStyle),
  'tokyo-night-day': syntaxOnly(tokyoNightDayStyle),
  'xcode-light': syntaxOnly(xcodeLightStyle),
  'vscode-dark': syntaxOnly(vscodeDarkStyle),
  dracula: syntaxOnly(draculaDarkStyle),
  nord: syntaxOnly(nordDarkStyle),
  'tokyo-night': syntaxOnly(tokyoNightStyle),
  'github-light': syntaxOnly(githubLightStyle),
  'github-dark': syntaxOnly(githubDarkStyle),
}

const defaultEditorTheme = EditorView.theme({
  '&': {
    color: 'var(--color-text)',
    backgroundColor: 'transparent',
  },
  '.cm-content': {
    caretColor: 'var(--color-primary)',
  },
  '.cm-gutters': {
    backgroundColor: 'transparent',
    color: 'var(--color-text-muted)',
    border: 'none',
  },
  '.cm-activeLine': { backgroundColor: 'rgba(var(--color-primary-rgb), 0.06)' },
  '.cm-activeLineGutter': { backgroundColor: 'rgba(var(--color-primary-rgb), 0.06)' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--color-primary)' },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, ::selection': {
    backgroundColor: 'rgba(var(--color-primary-rgb), 0.22)',
  },
  '.cm-matchingBracket': {
    backgroundColor: 'rgba(var(--color-primary-rgb), 0.18)',
    outline: '1px solid rgba(var(--color-primary-rgb), 0.4)',
  },
  '.cm-foldPlaceholder': {
    backgroundColor: 'var(--color-bg-muted)',
    border: 'none',
    color: 'var(--color-text-muted)',
  },
}, { dark: false })

export const editorThemeExtension = (theme: EditorThemeId, dark = false): Extension => [
  defaultEditorTheme,
  EditorView.darkTheme.of(dark),
  syntaxHighlighting(editorHighlightStyles[theme]),
]
