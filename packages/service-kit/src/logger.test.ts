import { Writable } from 'node:stream'

import { describe, expect, it } from 'vitest'

import { requestContext } from './context'
import { createLogger } from './logger'

function capture() {
  const lines: Record<string, unknown>[] = []
  const stream = new Writable({
    write(chunk: Buffer, _enc, cb) {
      for (const line of chunk.toString().split('\n').filter(Boolean))
        lines.push(JSON.parse(line) as Record<string, unknown>)
      cb()
    },
  })
  return { lines, stream }
}

describe('createLogger', () => {
  it('logs JSON with the service name', () => {
    const { lines, stream } = capture()
    createLogger({ service: 'order', level: 'info', destination: stream }).info(
      { orderId: 'o1' },
      'order paid',
    )
    expect(lines[0]).toMatchObject({ service: 'order', orderId: 'o1', msg: 'order paid' })
  })

  it('logger redacts authorization and password', () => {
    const { lines, stream } = capture()
    const log = createLogger({ service: 'identity', level: 'info', destination: stream })
    log.info({
      req: { headers: { authorization: 'Bearer abc', cookie: 'cr_rt=xyz' } },
      body: { password: 'hunter2hunter2', newPassword: 'n', currentPassword: 'c' },
      password: 'top-level',
    })
    const text = JSON.stringify(lines[0])
    for (const secret of ['Bearer abc', 'cr_rt=xyz', 'hunter2hunter2', 'top-level']) {
      expect(text).not.toContain(secret)
    }
    expect(text).toContain('[Redacted]')
  })

  it('redacts tokens, bank numbers and Razorpay signatures', () => {
    const { lines, stream } = capture()
    createLogger({ service: 'payment', level: 'info', destination: stream }).info({
      data: { token: 't1', accessToken: 't2', refreshToken: 't3', accountNumber: '123456789012' },
      payment: { razorpaySignature: 'sig1', razorpay_signature: 'sig2' },
    })
    const text = JSON.stringify(lines[0])
    for (const secret of ['t1', 't2', 't3', '123456789012', 'sig1', 'sig2']) {
      expect(text).not.toContain(`"${secret}"`)
    }
  })

  it('adds requestId and userId from the request context', () => {
    const { lines, stream } = capture()
    const log = createLogger({ service: 'cart', level: 'info', destination: stream })
    requestContext.run({ requestId: 'req-42', userId: 'u-7' }, () => {
      log.info('inside')
    })
    log.info('outside')
    expect(lines[0]).toMatchObject({ requestId: 'req-42', userId: 'u-7' })
    expect(lines[1]).not.toHaveProperty('requestId')
  })
})
