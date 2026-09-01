import assert from 'node:assert/strict'
import test from 'node:test'
import { createBashToolDefinition, type ExtensionContext } from '@earendil-works/pi-coding-agent'

test('Runtime-hosted Bash tolerates the absent ExtensionContext', async () => {
  let capturedEnv: NodeJS.ProcessEnv | undefined
  const definition = createBashToolDefinition(process.cwd(), {
    operations: {
      exec: async (_command, _cwd, options) => {
        capturedEnv = options.env
        return { exitCode: 0 }
      },
    },
  })

  const result = await definition.execute('bash-test', { command: 'true' }, undefined, undefined, undefined as unknown as ExtensionContext)

  assert.equal(result.content[0]?.type, 'text')
  assert.equal(result.content[0]?.type === 'text' ? result.content[0].text : undefined, '(no output)')
  assert.equal(capturedEnv?.PI_SESSION_ID, undefined)
})
