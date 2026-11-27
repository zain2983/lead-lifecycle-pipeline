// @sim-sdk 1
// Spike B: Start (API) -> Human "Approval" -> Condition on approved -> Response. No LLM.
// Resuming does not approve anything by itself: only the `yes` branch is the approved path.
import { condition, human, js, response, trigger, workflow } from '@sim/workflow-sdk'

export default workflow(
  'hello-approval',
  { description: 'Spike B: pause for a human decision, then branch on approved. No LLM.' },
  () => {
    const start = trigger.start('Start', { inputFormat: { item: 'string' } })
    const approval = human('Approval', {
      builderData: [{ name: 'item', type: 'string', value: start.item }],
      inputFormat: { approved: { type: 'boolean', required: true }, comment: 'string' },
    })
    const decided = condition('Approved', {
      yes: js`${approval.submission.approved} === true`,
      else: true,
    })
    const approved = response('Respond Approved', {
      body: { decision: 'approved', item: start.item },
    })
    const rejected = response('Respond Rejected', {
      body: { decision: 'rejected', item: start.item },
    })

    start.to(approval)
    approval.to(decided)
    decided.yes.to(approved)
    decided.else.to(rejected)
  }
)
