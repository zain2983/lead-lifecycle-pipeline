// @sim-sdk 1
// Spike B: Start (API) -> Function (echo + timestamp) -> Response. No LLM, no credentials.
import { fn, js, response, t, trigger, workflow } from '@sim/workflow-sdk'

export default workflow(
  'hello',
  { description: 'Spike B: echo the input with a timestamp. No LLM.' },
  () => {
    const start = trigger.start('Start', { inputFormat: { name: 'string' } })
    const echo = fn('Echo', {
      code: js`return { echo: ${start.name}, version: 'v2', greeting: 'Hello, ' + ${start.name}, at: new Date().toISOString() }`,
    })
    const reply = response('Respond', {
      body: {
        echo: t`${echo.result.echo}`,
        version: t`${echo.result.version}`,
        at: t`${echo.result.at}`,
      },
    })

    start.to(echo)
    echo.to(reply)
  }
)
