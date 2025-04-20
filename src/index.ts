import { Hono } from 'hono'

const app = new Hono<{ Bindings: Bindings }>()

app.get('/', async (c) => {
  return c.redirect("https://github.com/koiosdigital/device-provisioning-api")
})

export default app
