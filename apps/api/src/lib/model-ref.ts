/**
 * YARC identifies Pi models by the canonical `provider/modelId` reference.
 * Bare model ids are not unique: different providers can expose the same id
 * (e.g. a proxy provider re-exporting `gpt-4o`). Model ids may themselves
 * contain `/` (OpenRouter style), so the provider is everything before the
 * first slash.
 */
interface ModelIdentity { provider: string; id: string }

interface ModelLookup<T extends ModelIdentity> {
  getModel(provider: string, modelId: string): T | undefined
  getAvailable(): Promise<readonly T[]>
}

export const toModelRef = (model: ModelIdentity) => `${model.provider}/${model.id}`

/** Canonical ref of a (possibly partial) model; falls back to the bare id. */
export const modelRefOf = (model: Partial<ModelIdentity> | null | undefined): string | undefined => {
  if (!model?.id) return undefined
  return model.provider ? toModelRef(model as ModelIdentity) : model.id
}

export const sameModel = (a: Partial<ModelIdentity> | null | undefined, b: Partial<ModelIdentity> | null | undefined) =>
  !!a?.id && !!b?.id && a.id === b.id && (a.provider || '') === (b.provider || '')

/**
 * Find a model by canonical ref. Bare ids stored before refs were canonical
 * still resolve to the first model with that id (the previous behaviour).
 */
export const findModelByRef = <T extends ModelIdentity>(models: readonly T[], ref: string): T | undefined =>
  models.find(model => toModelRef(model) === ref) ?? models.find(model => model.id === ref)

/** Resolve a stored model ref against a Pi ModelRuntime/registry. */
export const resolveModelRef = async <T extends ModelIdentity>(
  runtime: ModelLookup<T> | null | undefined,
  ref: string | null | undefined,
): Promise<T | undefined> => {
  if (!runtime || !ref) return undefined
  const slash = ref.indexOf('/')
  if (slash > 0 && slash < ref.length - 1) {
    const model = runtime.getModel(ref.slice(0, slash), ref.slice(slash + 1))
    if (model) return model
  }
  return findModelByRef(await runtime.getAvailable(), ref)
}
