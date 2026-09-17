export const editorThemeOptions = [
  { value: 'default', label: 'YARC 默认（跟随外观）', kind: 'default' },
  { value: 'vscode-light', label: 'VS Code Light', kind: 'light' },
  { value: 'github-light', label: 'GitHub Light', kind: 'light' },
  { value: 'quietlight', label: 'Quiet Light', kind: 'light' },
  { value: 'solarized-light', label: 'Solarized Light', kind: 'light' },
  { value: 'tokyo-night-day', label: 'Tokyo Night Day', kind: 'light' },
  { value: 'xcode-light', label: 'Xcode Light', kind: 'light' },
  { value: 'vscode-dark', label: 'VS Code Dark', kind: 'dark' },
  { value: 'github-dark', label: 'GitHub Dark', kind: 'dark' },
  { value: 'dracula', label: 'Dracula', kind: 'dark' },
  { value: 'nord', label: 'Nord', kind: 'dark' },
  { value: 'tokyo-night', label: 'Tokyo Night', kind: 'dark' },
] as const

export const editorThemeGroups = [
  { kind: 'default', label: '默认' },
  { kind: 'light', label: '浅色主题' },
  { kind: 'dark', label: '深色主题' },
].map(group => ({
  label: group.label,
  options: editorThemeOptions.filter(option => option.kind === group.kind)
    .map(({ value, label }) => ({ value, label })),
}))

export type EditorThemeId = typeof editorThemeOptions[number]['value']

export const normalizeEditorTheme = (value: unknown): EditorThemeId =>
  editorThemeOptions.find(option => option.value === value)?.value ?? 'default'
