import { SettingsManager } from '@earendil-works/pi-coding-agent'

/** Keep SDK upgrades from introducing background model requests in YARC. */
export const createSessionSettings = (cwd: string, agentDir: string): SettingsManager => {
  const settings = SettingsManager.create(cwd, agentDir)
  // Override only this instance: setCacheWarmingMode() would save shared settings.
  settings.getCacheWarmingMode = () => 'off'
  return settings
}
