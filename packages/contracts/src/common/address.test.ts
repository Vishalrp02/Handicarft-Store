import { describe, expect, it } from 'vitest'

import { AddressInputSchema, AddressSchema } from './address'
import { INDIAN_STATES, IndianStateSchema } from './indian-states'

const valid = {
  fullName: 'Asha Rao',
  phone: '9876543210',
  line1: '12, Bapu Bazaar',
  city: 'Jaipur',
  state: 'Rajasthan',
  pincode: '302001',
  country: 'IN',
} as const

describe('IndianStateSchema', () => {
  it('lists 28 states and 8 union territories', () => {
    expect(INDIAN_STATES).toHaveLength(36)
    expect(new Set(INDIAN_STATES).size).toBe(36)
  })

  it('accepts official names and rejects others', () => {
    expect(IndianStateSchema.safeParse('Tamil Nadu').success).toBe(true)
    expect(IndianStateSchema.safeParse('Ladakh').success).toBe(true)
    expect(IndianStateSchema.safeParse('Dadra and Nagar Haveli and Daman and Diu').success).toBe(true)
    expect(IndianStateSchema.safeParse('Orissa').success).toBe(false)
    expect(IndianStateSchema.safeParse('rajasthan').success).toBe(false)
  })
})

describe('AddressInputSchema', () => {
  it('accepts a complete Indian address', () => {
    expect(AddressInputSchema.parse(valid)).toEqual(valid)
  })

  it('accepts optional line2 and landmark', () => {
    const r = AddressInputSchema.safeParse({
      ...valid,
      line2: 'Near Hawa Mahal',
      landmark: 'Opp. post office',
    })
    expect(r.success).toBe(true)
  })

  it('trims surrounding whitespace', () => {
    const r = AddressInputSchema.parse({ ...valid, fullName: '  Asha Rao  ', city: ' Jaipur ' })
    expect(r.fullName).toBe('Asha Rao')
    expect(r.city).toBe('Jaipur')
  })

  it('rejects pincode starting with 0', () => {
    expect(AddressInputSchema.safeParse({ ...valid, pincode: '012345' }).success).toBe(false)
  })

  it('rejects pincode that is not 6 digits', () => {
    expect(AddressInputSchema.safeParse({ ...valid, pincode: '30200' }).success).toBe(false)
    expect(AddressInputSchema.safeParse({ ...valid, pincode: '3020011' }).success).toBe(false)
  })

  it('rejects phone not starting 6-9', () => {
    expect(AddressInputSchema.safeParse({ ...valid, phone: '5876543210' }).success).toBe(false)
  })

  it('rejects phone with country code or wrong length', () => {
    expect(AddressInputSchema.safeParse({ ...valid, phone: '+919876543210' }).success).toBe(false)
    expect(AddressInputSchema.safeParse({ ...valid, phone: '987654321' }).success).toBe(false)
  })

  it('rejects non-Indian country and unknown state', () => {
    expect(AddressInputSchema.safeParse({ ...valid, country: 'US' }).success).toBe(false)
    expect(AddressInputSchema.safeParse({ ...valid, state: 'Bavaria' }).success).toBe(false)
  })

  it('enforces length limits', () => {
    expect(AddressInputSchema.safeParse({ ...valid, fullName: 'A' }).success).toBe(false)
    expect(AddressInputSchema.safeParse({ ...valid, line1: 'x'.repeat(121) }).success).toBe(false)
    expect(AddressInputSchema.safeParse({ ...valid, landmark: 'x'.repeat(81) }).success).toBe(false)
  })
})

describe('AddressSchema', () => {
  it('adds id, label and isDefault', () => {
    const r = AddressSchema.safeParse({
      ...valid,
      id: '0192f7a4-3b6c-7d2e-8f10-1a2b3c4d5e6f',
      label: 'Home',
      isDefault: true,
    })
    expect(r.success).toBe(true)
  })

  it('allows a null label but not a long one', () => {
    const base = { ...valid, id: '0192f7a4-3b6c-7d2e-8f10-1a2b3c4d5e6f', isDefault: false }
    expect(AddressSchema.safeParse({ ...base, label: null }).success).toBe(true)
    expect(AddressSchema.safeParse({ ...base, label: 'x'.repeat(31) }).success).toBe(false)
  })
})
