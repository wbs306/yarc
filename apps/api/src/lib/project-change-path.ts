import { relative, resolve, sep } from 'node:path'
import { config } from './config.js'
import { normalizeProjectRelativePath, validateProjectDirectoryName } from './project-path.js'

// Reuse DATA_DIR's watcher when projects are underneath it. External projects
// reuse the same watcher implementation, rooted at PROJECTS_DIR instead.
export const projectChangeScope = () => {
  const dataRoot = resolve(config.dataDir)
  const projectsRoot = resolve(config.projectsDir)
  if (projectsRoot === dataRoot || projectsRoot.startsWith(`${dataRoot}${sep}`)) {
    const path = relative(dataRoot, projectsRoot).replace(/\\/g, '/')
    return { root: dataRoot, prefix: path ? `${path}/` : '' }
  }
  return { root: projectsRoot, prefix: '' }
}

export const projectChangePath = (directoryName: string, path: string) => {
  const scope = projectChangeScope()
  const relativePath = normalizeProjectRelativePath(path)
  return {
    root: scope.root,
    path: `${scope.prefix}${validateProjectDirectoryName(directoryName)}${relativePath ? `/${relativePath}` : ''}`,
  }
}

export const parseProjectChangePath = (path: string) => {
  const { prefix } = projectChangeScope()
  if (!path.startsWith(prefix)) return null
  const [directoryName, ...parts] = path.slice(prefix.length).split('/')
  if (!directoryName || !parts.length) return null
  try {
    return { directoryName: validateProjectDirectoryName(directoryName), relativePath: normalizeProjectRelativePath(parts.join('/')) }
  } catch {
    return null
  }
}
