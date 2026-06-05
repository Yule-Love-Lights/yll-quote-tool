---
name: reference-hhc
description: Holiday Home Concepts — the live web tool we are cloning for Yule Love Lights
metadata: 
  node_type: memory
  type: reference
  originSessionId: f873dbf4-c7e5-42d7-9853-231824d98139
---

**Holiday Home Concepts (HHC)** — https://new.holidayhomeconcepts.com/dash/ — is the production SaaS tool Jason uses today for designing Christmas light installations on customer home photos. We are building an internal clone of it ([[project-design-tool]]).

Useful URLs (require login):
- Dashboard: `/dash/`
- Project (design canvas): `/project/<external_id>/`
- Proposal (client share page): `/proposal/<external_id>/?access_token=<token>`
- Inventory: `/inventory/`
- Calculator (wrap calculator): opens from `/inventory/` Calculator nav button
- Settings: `/settings/`
- Need Graphics gallery: `/need-graphics/`

To inspect anything new about HHC, open it in Claude in Chrome and have Jason log in (we cannot create accounts on his behalf). Architecture notes from inspection: [[project-hhc-architecture]].
