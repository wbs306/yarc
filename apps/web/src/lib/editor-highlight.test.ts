import assert from 'node:assert/strict'
import test from 'node:test'
import { Compartment, EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { history, undoDepth } from '@codemirror/commands'
import { githubDarkStyle, githubLightStyle } from '@uiw/codemirror-theme-github'
import { vscodeDarkStyle, vscodeLightStyle } from '@uiw/codemirror-theme-vscode'
import { draculaDarkStyle } from '@uiw/codemirror-theme-dracula'
import { nordDarkStyle } from '@uiw/codemirror-theme-nord'
import { tokyoNightStyle } from '@uiw/codemirror-theme-tokyo-night'
import { quietlightStyle } from '@uiw/codemirror-theme-quietlight'
import { solarizedLightStyle } from '@uiw/codemirror-theme-solarized'
import { tokyoNightDayStyle } from '@uiw/codemirror-theme-tokyo-night-day'
import { xcodeLightStyle } from '@uiw/codemirror-theme-xcode'
import { editorHighlightStyles, editorThemeExtension } from './editor-highlight'
import { editorThemeGroups, editorThemeOptions, normalizeEditorTheme } from './editor-theme-options'

test('missing or unsupported saved editor themes fall back to the original theme', () => {
  for (const value of [undefined, null, '', 'unknown', {}, 42]) {
    assert.equal(normalizeEditorTheme(value), 'default')
  }
  for (const { value } of editorThemeOptions) {
    assert.equal(normalizeEditorTheme(JSON.parse(JSON.stringify(value))), value)
  }
})

test('selector groups separate default, light and dark palettes without missing or duplicate options', () => {
  assert.deepEqual(editorThemeGroups.map(group => group.label), ['默认', '浅色主题', '深色主题'])
  const groups = editorThemeGroups.map(group => group.options.map(option => option.value))
  assert.deepEqual(groups[0], ['default'])
  assert.deepEqual(groups[1], ['vscode-light', 'github-light', 'quietlight', 'solarized-light', 'tokyo-night-day', 'xcode-light'])
  assert.deepEqual(groups[2], ['vscode-dark', 'github-dark', 'dracula', 'nord', 'tokyo-night'])
  assert.deepEqual(groups.flat(), editorThemeOptions.map(option => option.value))
  assert.equal(new Set(groups.flat()).size, editorThemeOptions.length)
})

test('all preset palettes retain package text colors but never import token backgrounds', () => {
  const presets = {
    'github-light': githubLightStyle,
    'github-dark': githubDarkStyle,
    'vscode-light': vscodeLightStyle,
    quietlight: quietlightStyle,
    'solarized-light': solarizedLightStyle,
    'tokyo-night-day': tokyoNightDayStyle,
    'xcode-light': xcodeLightStyle,
    'vscode-dark': vscodeDarkStyle,
    dracula: draculaDarkStyle,
    nord: nordDarkStyle,
    'tokyo-night': tokyoNightStyle,
  } as const
  for (const id of Object.keys(presets) as Array<keyof typeof presets>) {
    assert.deepEqual(editorHighlightStyles[id].specs.map(spec => spec.color), presets[id].map(spec => spec.color))
    assert.deepEqual(editorHighlightStyles[id].specs.map(spec => spec.tag), presets[id].map(spec => spec.tag))
  }
  for (const { value } of editorThemeOptions) {
    assert.ok(editorHighlightStyles[value].specs.every(spec => !('backgroundColor' in spec)))
  }
})

test('theme switches preserve unsaved text, cursor and undo history', () => {
  const theme = new Compartment()
  let state = EditorState.create({ doc: 'draft', extensions: [history(), theme.of(editorThemeExtension('default'))] })
  state = state.update({ changes: { from: 5, insert: ' notes' }, selection: { anchor: 11 } }).state
  const depth = undoDepth(state)
  assert.equal(depth, 1)
  for (const appDark of [true, false]) {
    for (const { value } of editorThemeOptions) {
      state = state.update({ effects: theme.reconfigure(editorThemeExtension(value, appDark)) }).state
      assert.equal(state.doc.toString(), 'draft notes')
      assert.equal(state.selection.main.head, 11)
      assert.equal(undoDepth(state), depth)
      assert.equal(state.facet(EditorView.darkTheme), appDark, 'palette must not change editor light/dark mode')
    }
  }
})
