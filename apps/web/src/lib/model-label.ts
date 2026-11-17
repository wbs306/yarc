export interface LabeledModel {
  /** Canonical `provider/modelId` reference. */
  id: string
  name?: string
  provider?: string
  /** Bare model id within its provider. */
  model?: string
}

export interface ModelLabel {
  name: string
  /** Disambiguating tag; empty when the display name is unique. */
  tag: string
}

export const modelDisplayName = (model: LabeledModel) => model.name || model.model || model.id

/**
 * Build display labels for a model list. Models whose display name is shared
 * get the provider as a tag; if the same provider exposes the name more than
 * once, the full `provider/modelId` reference is used instead.
 */
export const buildModelLabels = (models: readonly LabeledModel[]): Map<string, ModelLabel> => {
  const groups = new Map<string, LabeledModel[]>()
  for (const model of models) {
    const key = modelDisplayName(model).trim().toLowerCase()
    const group = groups.get(key)
    if (group) group.push(model)
    else groups.set(key, [model])
  }

  const labels = new Map<string, ModelLabel>()
  for (const group of groups.values()) {
    const providers = group.map(model => model.provider || '')
    const providersDistinct = providers.every(Boolean) && new Set(providers).size === group.length
    for (const model of group) {
      const tag = group.length === 1 ? '' : providersDistinct ? model.provider! : model.id
      labels.set(model.id, { name: modelDisplayName(model), tag })
    }
  }
  return labels
}

export const formatModelLabel = (label: ModelLabel) => label.tag ? `${label.name} (${label.tag})` : label.name
