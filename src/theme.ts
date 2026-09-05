// Theme tokens for the fullscreen shell: the single place components read
// colors and border styles from. Dark terminal palette in the spirit of
// opencode's default look — never scatter raw color literals in components.
export const theme = {
  colors: {
    headerBg: '#1c2128',
    headerFg: '#e6edf3',
    accent: '#7aa2f7',
    border: '#30363d',
    muted: '#6e7681',
    user: '#7ee787',
    event: '#d29922',
    error: '#f85149',
    cursor: '#7aa2f7',
    selectedBg: '#30363d',
  },
  borders: {
    composer: 'round',
    sidebar: 'single',
  },
} as const

export type Theme = typeof theme
