import { relative, resolve } from 'node:path'

export const formatPathRelativeToWorkspace = (
  filePath: string,
  workspaceCwd: string,
  rootDir: string,
) => {
  const target = resolve(rootDir, filePath.replace(/\\/g, '/'))
  return relative(resolve(workspaceCwd), target).replace(/\\/g, '/') || '.'
}
