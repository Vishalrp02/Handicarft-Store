import { describe, expect, it } from 'vitest'

import {
  AccessTokenClaimsSchema,
  AddressCreateBodySchema,
  AdminRefundRequestSchema,
  AuthResultSchema,
  BankAccountInSchema,
  CartMergeBodySchema,
  CartSchema,
  ChangePasswordBodySchema,
  CheckoutRequestSchema,
  CheckoutResponseSchema,
  CreatePaymentIntentSchema,
  ImageUploadUrlBodySchema,
  InternalCartSchema,
  LedgerEntrySchema,
  LoginBodySchema,
  OrderSchema,
  ProductSearchQuerySchema,
  ProductUpdateSchema,
  ProductUpsertSchema,
  RegisterBodySchema,
  ReserveRequestSchema,
  ReserveResponseSchema,
  ReviewCreateBodySchema,
  SellerApplySchema,
  SellerProductSchema,
  SetCartQtyBodySchema,
  ShipBodySchema,
  VerifyPaymentSchema,
} from '../index'

const uuid = (n: number) => `0192f7a4-3b6c-7d2e-8f10-${String(n).padStart(12, '0')}`
const at = '2026-10-07T10:15:30.123Z'
const address = {
  fullName: 'Asha Rao',
  phone: '9876543210',
  line1: '12, Bapu Bazaar',
  city: 'Jaipur',
  state: 'Rajasthan',
  pincode: '302001',
  country: 'IN',
} as const

const product = {
  title: 'Blue pottery vase',
  description: 'Hand-painted Jaipur blue pottery, cobalt on white, quartz body.',
  categoryId: uuid(1),
  pricePaise: 245000,
}

describe('catalog', () => {
  it('ProductUpsert accepts a minimal product', () => {
    expect(ProductUpsertSchema.safeParse(product).success).toBe(true)
  })

  it('ProductUpsert rejects price below ₹1', () => {
    expect(ProductUpsertSchema.safeParse({ ...product, pricePaise: 99 }).success).toBe(false)
  })

  it('ProductUpsert rejects price above ₹1,00,000', () => {
    expect(ProductUpsertSchema.safeParse({ ...product, pricePaise: 10_000_001 }).success).toBe(false)
  })

  it('ProductUpsert rejects compareAt <= price', () => {
    expect(ProductUpsertSchema.safeParse({ ...product, compareAtPricePaise: 245000 }).success).toBe(false)
    expect(ProductUpsertSchema.safeParse({ ...product, compareAtPricePaise: 300000 }).success).toBe(true)
  })

  it('ProductUpsert rejects unknown GST rates and bad HSN codes', () => {
    expect(ProductUpsertSchema.safeParse({ ...product, taxRateBps: 700 }).success).toBe(false)
    expect(ProductUpsertSchema.safeParse({ ...product, hsnCode: '69A1' }).success).toBe(false)
    expect(ProductUpsertSchema.safeParse({ ...product, taxRateBps: 1200, hsnCode: '6913' }).success).toBe(
      true,
    )
  })

  it('ProductUpdate allows partial bodies but still checks compareAt when both are sent', () => {
    expect(ProductUpdateSchema.safeParse({ pricePaise: 150000 }).success).toBe(true)
    expect(ProductUpdateSchema.safeParse({ pricePaise: 150000, compareAtPricePaise: 100000 }).success).toBe(
      false,
    )
  })

  it('ProductSearchQuery coerces numbers and defaults sort', () => {
    const q = ProductSearchQuerySchema.parse({ minPrice: '100', page: '2' })
    expect(q.minPrice).toBe(100)
    expect(q.page).toBe(2)
    expect(q.sort).toBe('relevance')
    expect(q.limit).toBe(24)
  })

  it('ProductSearchQuery reads inStock=false as false', () => {
    expect(ProductSearchQuerySchema.parse({ inStock: 'false' }).inStock).toBe(false)
    expect(ProductSearchQuerySchema.parse({ inStock: 'true' }).inStock).toBe(true)
  })

  it('ProductSearchQuery rejects inverted price range and long queries', () => {
    expect(ProductSearchQuerySchema.safeParse({ minPrice: '5000', maxPrice: '100' }).success).toBe(false)
    expect(ProductSearchQuerySchema.safeParse({ q: 'x'.repeat(101) }).success).toBe(false)
  })

  it('ImageUploadUrlBody limits type and size', () => {
    expect(
      ImageUploadUrlBodySchema.safeParse({ contentType: 'image/webp', contentLength: 10_485_760 }).success,
    ).toBe(true)
    expect(ImageUploadUrlBodySchema.safeParse({ contentType: 'image/gif', contentLength: 100 }).success).toBe(
      false,
    )
    expect(
      ImageUploadUrlBodySchema.safeParse({ contentType: 'image/png', contentLength: 10_485_761 }).success,
    ).toBe(false)
  })

  it('ReviewCreateBody accepts ratings 1 to 5 only', () => {
    expect(ReviewCreateBodySchema.safeParse({ rating: 5 }).success).toBe(true)
    expect(ReviewCreateBodySchema.safeParse({ rating: 0 }).success).toBe(false)
    expect(ReviewCreateBodySchema.safeParse({ rating: 4.5 }).success).toBe(false)
  })

  it('SellerProduct parses a realistic response', () => {
    const image = {
      id: uuid(9),
      alt: 'Vase from the front',
      position: 0,
      width: 2000,
      height: 2400,
      variants: [400, 800, 1600].map((width) => ({
        width,
        url: `https://media.craftoria.in/p/x/y-${String(width)}.webp`,
      })),
    }
    const sample = {
      id: uuid(2),
      slug: 'blue-pottery-vase-a1b2c3',
      title: product.title,
      pricePaise: 245000,
      compareAtPricePaise: null,
      primaryImage: image,
      seller: { id: uuid(3), slug: 'jaipur-blue', displayName: 'Jaipur Blue', region: 'Jaipur, Rajasthan' },
      ratingAvg: 4.5,
      ratingCount: 12,
      inStock: true,
      craftTechnique: 'Blue pottery',
      description: product.description,
      category: {
        id: uuid(1),
        slug: 'pottery',
        name: 'Pottery',
        parentId: null,
        description: null,
        productCount: 40,
      },
      images: [image],
      materials: ['quartz', 'glass'],
      originRegion: 'Jaipur',
      dimensionsCm: { l: 12, w: 12, h: 30 },
      weightGrams: 900,
      careInstructions: null,
      makingTimeDays: 4,
      availableQty: 3,
      taxRateBps: 1200,
      publishedAt: at,
      status: 'active',
      rejectionReason: null,
      onHand: 3,
      reserved: 0,
      hsnCode: '6913',
      updatedAt: at,
    }
    expect(SellerProductSchema.safeParse(sample).success).toBe(true)
  })
})

describe('internal reservations', () => {
  const req = { reservationId: uuid(5), items: [{ productId: uuid(2), qty: 1 }], ttlSeconds: 1800 }

  it('ReserveRequest accepts a valid request', () => {
    expect(ReserveRequestSchema.safeParse(req).success).toBe(true)
  })

  it('ReserveRequest rejects qty 11 and 51 lines', () => {
    expect(ReserveRequestSchema.safeParse({ ...req, items: [{ productId: uuid(2), qty: 11 }] }).success).toBe(
      false,
    )
    const many = Array.from({ length: 51 }, (_, i) => ({ productId: uuid(100 + i), qty: 1 }))
    expect(ReserveRequestSchema.safeParse({ ...req, items: many }).success).toBe(false)
  })

  it('ReserveRequest rejects duplicate products and out-of-range TTL', () => {
    const dup = [
      { productId: uuid(2), qty: 1 },
      { productId: uuid(2), qty: 2 },
    ]
    expect(ReserveRequestSchema.safeParse({ ...req, items: dup }).success).toBe(false)
    expect(ReserveRequestSchema.safeParse({ ...req, ttlSeconds: 59 }).success).toBe(false)
  })

  it('ReserveResponse parses priced lines', () => {
    const res = {
      reservationId: uuid(5),
      expiresAt: at,
      lines: [
        {
          productId: uuid(2),
          sellerId: uuid(3),
          sellerDisplayName: 'Jaipur Blue',
          title: 'Blue pottery vase',
          slug: 'blue-pottery-vase-a1b2c3',
          imageUrl: null,
          unitPricePaise: 245000,
          qty: 1,
          taxRateBps: 1200,
        },
      ],
    }
    expect(ReserveResponseSchema.safeParse(res).success).toBe(true)
  })
})

describe('identity', () => {
  it('Register normalises email and enforces password length', () => {
    const r = RegisterBodySchema.parse({
      name: 'Asha Rao',
      email: '  Asha@Example.IN ',
      password: 'correct-horse',
    })
    expect(r.email).toBe('asha@example.in')
    expect(RegisterBodySchema.safeParse({ name: 'Asha', email: 'a@x.in', password: 'short' }).success).toBe(
      false,
    )
  })

  it('Login does not reveal the password policy', () => {
    expect(LoginBodySchema.safeParse({ email: 'a@x.in', password: 'x' }).success).toBe(true)
    expect(LoginBodySchema.safeParse({ email: 'not-an-email', password: 'x' }).success).toBe(false)
  })

  it('ChangePassword requires a different new password', () => {
    expect(
      ChangePasswordBodySchema.safeParse({ currentPassword: 'old-password-1', newPassword: 'old-password-1' })
        .success,
    ).toBe(false)
  })

  it('AddressCreateBody adds optional label and isDefault', () => {
    expect(AddressCreateBodySchema.safeParse({ ...address, label: 'Home', isDefault: true }).success).toBe(
      true,
    )
  })

  it('AuthResult and claims parse', () => {
    const user = {
      id: uuid(7),
      email: 'asha@example.in',
      name: 'Asha Rao',
      phone: null,
      emailVerified: true,
      roles: ['buyer', 'artisan'],
      sellerId: uuid(3),
      createdAt: at,
    }
    expect(
      AuthResultSchema.safeParse({ user, accessToken: 'eyJ...', accessTokenExpiresAt: at }).success,
    ).toBe(true)
    const claims = {
      sub: uuid(7),
      email: user.email,
      name: user.name,
      emailVerified: true,
      roles: ['buyer'],
      sid: uuid(8),
      iss: 'craftoria-identity',
      aud: 'craftoria',
      iat: 1791396000,
      exp: 1791396900,
    }
    expect(AccessTokenClaimsSchema.safeParse(claims).success).toBe(true)
    expect(AccessTokenClaimsSchema.safeParse({ ...claims, roles: [] }).success).toBe(false)
  })
})

describe('seller', () => {
  const apply = {
    displayName: 'Jaipur Blue',
    craft: 'Blue pottery',
    region: 'Jaipur',
    contactPhone: '9876543210',
  }

  it('SellerApply validates GSTIN format', () => {
    expect(SellerApplySchema.safeParse({ ...apply, gstin: '27AAPFU0939F1ZV' }).success).toBe(true)
    expect(SellerApplySchema.safeParse({ ...apply, gstin: 'ABC' }).success).toBe(false)
  })

  it('BankAccountIn validates IFSC', () => {
    const bank = { accountHolderName: 'Asha Rao', accountNumber: '123456789012' }
    expect(BankAccountInSchema.safeParse({ ...bank, ifsc: 'HDFC0001234' }).success).toBe(true)
    expect(BankAccountInSchema.safeParse({ ...bank, ifsc: 'HDFC1001234' }).success).toBe(false)
    expect(
      BankAccountInSchema.safeParse({ ...bank, ifsc: 'HDFC0001234', accountNumber: '12345' }).success,
    ).toBe(false)
  })

  it('LedgerEntry allows signed amounts', () => {
    const entry = {
      id: uuid(10),
      sellerOrderId: uuid(11),
      orderNumber: 'CR-2610-000123',
      type: 'commission',
      amountPaise: -24500,
      status: 'pending',
      availableAt: null,
      createdAt: at,
    }
    expect(LedgerEntrySchema.safeParse(entry).success).toBe(true)
  })
})

describe('cart', () => {
  it('Cart qty 0..10 only', () => {
    expect(SetCartQtyBodySchema.safeParse({ qty: 0 }).success).toBe(true)
    expect(SetCartQtyBodySchema.safeParse({ qty: 10 }).success).toBe(true)
    expect(SetCartQtyBodySchema.safeParse({ qty: 11 }).success).toBe(false)
    expect(SetCartQtyBodySchema.safeParse({ qty: -1 }).success).toBe(false)
  })

  it('CartMerge caps at 50 items with qty 1..10', () => {
    const items = Array.from({ length: 51 }, (_, i) => ({ productId: uuid(200 + i), qty: 1 }))
    expect(CartMergeBodySchema.safeParse({ items }).success).toBe(false)
    expect(CartMergeBodySchema.safeParse({ items: [{ productId: uuid(2), qty: 0 }] }).success).toBe(false)
  })

  it('Cart and InternalCart parse', () => {
    const cart = {
      items: [
        {
          productId: uuid(2),
          qty: 2,
          product: {
            title: 'Blue pottery vase',
            slug: 'blue-pottery-vase-a1b2c3',
            pricePaise: 245000,
            imageUrl: null,
            sellerDisplayName: 'Jaipur Blue',
            isPurchasable: true,
          },
        },
      ],
      itemCount: 2,
      subtotalPaise: 490000,
      updatedAt: at,
    }
    expect(CartSchema.safeParse(cart).success).toBe(true)
    expect(InternalCartSchema.safeParse({ items: [{ productId: uuid(2), qty: 2 }] }).success).toBe(true)
  })
})

describe('order', () => {
  it('CheckoutRequest requires full address', () => {
    expect(CheckoutRequestSchema.safeParse({ shippingAddress: address }).success).toBe(true)
    const { pincode: _omit, ...partial } = address
    expect(CheckoutRequestSchema.safeParse({ shippingAddress: partial }).success).toBe(false)
  })

  it('CheckoutRequest ignores client prices', () => {
    const r = CheckoutRequestSchema.parse({ shippingAddress: address, totalPaise: 1 })
    expect(r).not.toHaveProperty('totalPaise')
  })

  it('ShipBody requires carrier and tracking number', () => {
    expect(ShipBodySchema.safeParse({ carrier: 'India Post', trackingNumber: 'EE123456789IN' }).success).toBe(
      true,
    )
    expect(ShipBodySchema.safeParse({ carrier: 'India Post' }).success).toBe(false)
  })

  it('Order and CheckoutResponse parse a realistic order', () => {
    const order = {
      id: uuid(20),
      orderNumber: 'CR-2610-000123',
      status: 'pending_payment',
      displayStatus: 'Awaiting payment',
      itemsSubtotalPaise: 245000,
      shippingPaise: 0,
      totalPaise: 245000,
      currency: 'INR',
      shippingAddress: address,
      sellerOrders: [
        {
          id: uuid(21),
          sellerId: uuid(3),
          sellerDisplayName: 'Jaipur Blue',
          status: 'pending',
          subtotalPaise: 245000,
          items: [
            {
              id: uuid(22),
              productId: uuid(2),
              title: 'Blue pottery vase',
              slug: 'blue-pottery-vase-a1b2c3',
              imageUrl: null,
              unitPricePaise: 245000,
              qty: 1,
              lineTotalPaise: 245000,
              taxRateBps: 1200,
            },
          ],
          trackingCarrier: null,
          trackingNumber: null,
          refundStatus: 'none',
          cancelReason: null,
          acceptedAt: null,
          shippedAt: null,
          deliveredAt: null,
          cancelledAt: null,
        },
      ],
      placedAt: at,
      paidAt: null,
      expiresAt: at,
      cancelledAt: null,
      cancelReason: null,
    }
    expect(OrderSchema.safeParse(order).success).toBe(true)
    const res = {
      order,
      payment: {
        provider: 'razorpay',
        keyId: 'rzp_test_x',
        gatewayOrderId: 'order_RZP123',
        amountPaise: 245000,
        currency: 'INR',
      },
    }
    expect(CheckoutResponseSchema.safeParse(res).success).toBe(true)
  })
})

describe('payment', () => {
  it('CreatePaymentIntent bounds the amount', () => {
    const base = {
      orderId: uuid(20),
      userId: uuid(7),
      customer: { name: 'Asha', email: 'a@x.in', phone: '9876543210' },
    }
    expect(CreatePaymentIntentSchema.safeParse({ ...base, amountPaise: 245000 }).success).toBe(true)
    expect(CreatePaymentIntentSchema.safeParse({ ...base, amountPaise: 99 }).success).toBe(false)
    expect(CreatePaymentIntentSchema.safeParse({ ...base, amountPaise: 50_000_001 }).success).toBe(false)
  })

  it('VerifyPayment requires all three Razorpay fields', () => {
    expect(
      VerifyPaymentSchema.safeParse({
        razorpayOrderId: 'order_1',
        razorpayPaymentId: 'pay_1',
        razorpaySignature: 'ab',
      }).success,
    ).toBe(true)
    expect(
      VerifyPaymentSchema.safeParse({ razorpayOrderId: 'order_1', razorpayPaymentId: 'pay_1' }).success,
    ).toBe(false)
  })

  it('AdminRefundRequest needs a reason and positive amount', () => {
    expect(
      AdminRefundRequestSchema.safeParse({ orderId: uuid(20), amountPaise: 1000, reason: 'Damaged' }).success,
    ).toBe(true)
    expect(
      AdminRefundRequestSchema.safeParse({ orderId: uuid(20), amountPaise: 0, reason: 'Damaged' }).success,
    ).toBe(false)
    expect(
      AdminRefundRequestSchema.safeParse({ orderId: uuid(20), amountPaise: 1000, reason: 'x' }).success,
    ).toBe(false)
  })
})
