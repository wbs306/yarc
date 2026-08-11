const strongContentPattern = '(?:\\\\.|[^*]|\\*(?!\\*))+?'

export const pairedStrongRule = new RegExp(`^\\*\\*(${strongContentPattern})\\*\\*`, 'u')
export const relaxedStrongRule = new RegExp(`^\\*\\*(${strongContentPattern}\\p{P})\\*\\*(?=[^\\s\\p{P}])`, 'u')
