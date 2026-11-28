// @sim-sdk 1
// Read-only smoke test: Sim reads one synthetic contact from the `demo` test account with the `HubSpot demo`
// credential and returns its fixture_key. Start (API) -> HubSpot Get Contacts -> Function -> Response. No LLM.
import { credential, fn, hubspot, js, response, t, trigger, workflow } from '@sim/workflow-sdk'

export default workflow(
  'hubspot-smoke',
  {
    description:
      'Read one synthetic HubSpot contact and return its fixture_key. Read-only, no LLM.',
  },
  () => {
    const start = trigger.start('Start', { inputFormat: { contactId: 'string' } })
    const getContact = hubspot.getContacts('Get Contact', {
      credential: credential('hubspot-demo'),
      contactId: start.contactId,
      properties: 'fixture_key',
    })
    const pick = fn('Pick', {
      code: js`const contact = ${getContact.contact}
return { id: contact?.id ?? null, fixtureKey: contact?.properties?.fixture_key ?? null }`,
    })
    const reply = response('Respond', {
      body: { contactId: t`${pick.result.id}`, fixtureKey: t`${pick.result.fixtureKey}` },
    })

    start.to(getContact)
    getContact.to(pick)
    pick.to(reply)
  }
)
