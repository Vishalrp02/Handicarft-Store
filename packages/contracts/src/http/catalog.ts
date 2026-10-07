import { z } from 'zod'

import { ReasonSchema, SlugSchema } from '../common/fields'
import { IsoDateSchema, UuidSchema } from '../common/ids'
import { PaiseSchema } from '../common/money'
import { CursorQuerySchema, PageQuerySchema, PageSchema } from '../common/pagination'

export const ProductStatusSchema = z.enum(['draft', 'pending_review', 'active', 'rejected', 'archived'])
export type ProductStatus = z.infer<typeof ProductStatusSchema>

/** GST slabs in basis points (0 %, 5 %, 12 %, 18 %, 28 %). */
export const TaxRateBpsSchema = z.union([
  z.literal(0),
  z.literal(500),
  z.literal(1200),
  z.literal(1800),
  z.literal(2800),
])
export type TaxRateBps = z.infer<typeof TaxRateBpsSchema>

export const ImageWidthSchema = z.union([z.literal(400), z.literal(800), z.literal(1600)])

export const DimensionsCmSchema = z.object({
  l: z.number().positive().max(500),
  w: z.number().positive().max(500),
  h: z.number().positive().max(500),
})

// --- responses ----------------------------------------------------------------

export const CategorySchema = z.object({
  id: UuidSchema,
  slug: z.string(),
  name: z.string(),
  parentId: UuidSchema.nullable(),
  description: z.string().nullable(),
  productCount: z.number().int().nonnegative(),
})
export type Category = z.infer<typeof CategorySchema>

export const ImageVariantSchema = z.object({ width: ImageWidthSchema, url: z.string() })

export const ProductImageSchema = z.object({
  id: UuidSchema,
  alt: z.string(),
  position: z.number().int().nonnegative(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  variants: z.array(ImageVariantSchema),
})
export type ProductImage = z.infer<typeof ProductImageSchema>

export const SellerBadgeSchema = z.object({
  id: UuidSchema,
  slug: z.string(),
  displayName: z.string(),
  region: z.string().nullable(),
})
export type SellerBadge = z.infer<typeof SellerBadgeSchema>

export const ProductCardSchema = z.object({
  id: UuidSchema,
  slug: z.string(),
  title: z.string(),
  pricePaise: PaiseSchema,
  compareAtPricePaise: PaiseSchema.nullable(),
  primaryImage: ProductImageSchema.nullable(),
  seller: SellerBadgeSchema,
  ratingAvg: z.number().nullable(),
  ratingCount: z.number().int().nonnegative(),
  inStock: z.boolean(),
  craftTechnique: z.string().nullable(),
})
export type ProductCard = z.infer<typeof ProductCardSchema>

export const ProductDetailSchema = ProductCardSchema.extend({
  description: z.string(),
  category: CategorySchema,
  images: z.array(ProductImageSchema),
  materials: z.array(z.string()),
  originRegion: z.string().nullable(),
  dimensionsCm: DimensionsCmSchema.nullable(),
  weightGrams: z.number().int().nullable(),
  careInstructions: z.string().nullable(),
  makingTimeDays: z.number().int().nullable(),
  /** Capped at 10 for display. */
  availableQty: z.number().int().min(0).max(10),
  taxRateBps: z.number().int(),
  publishedAt: IsoDateSchema,
})
export type ProductDetail = z.infer<typeof ProductDetailSchema>

export const SellerProductSchema = ProductDetailSchema.extend({
  status: ProductStatusSchema,
  rejectionReason: z.string().nullable(),
  onHand: z.number().int().nonnegative(),
  reserved: z.number().int().nonnegative(),
  hsnCode: z.string().nullable(),
  updatedAt: IsoDateSchema,
  // a draft has never been published
  publishedAt: IsoDateSchema.nullable(),
  // a draft may have no seller-visible stock yet; uncapped for the owner
  availableQty: z.number().int().nonnegative(),
})
export type SellerProduct = z.infer<typeof SellerProductSchema>

export const ReviewSchema = z.object({
  id: UuidSchema,
  productId: UuidSchema,
  /** First word of the name + initial of the last word, e.g. "Asha R." */
  authorName: z.string(),
  rating: z.number().int().min(1).max(5),
  title: z.string().nullable(),
  body: z.string().nullable(),
  verifiedPurchase: z.literal(true),
  createdAt: IsoDateSchema,
})
export type Review = z.infer<typeof ReviewSchema>

export const ReviewSummarySchema = z.object({
  avg: z.number().nullable(),
  count: z.number().int().nonnegative(),
  distribution: z.tuple([z.number(), z.number(), z.number(), z.number(), z.number()]),
})

export const ReviewPageSchema = PageSchema(ReviewSchema).extend({ summary: ReviewSummarySchema })
export type ReviewPage = z.infer<typeof ReviewPageSchema>

export const InventoryOutSchema = z.object({
  onHand: z.number().int().nonnegative(),
  reserved: z.number().int().nonnegative(),
  available: z.number().int().nonnegative(),
})
export type InventoryOut = z.infer<typeof InventoryOutSchema>

export const ImageUploadUrlResponseSchema = z.object({
  uploadUrl: z.string(),
  storageKey: z.string(),
  expiresAt: IsoDateSchema,
})
export type ImageUploadUrlResponse = z.infer<typeof ImageUploadUrlResponseSchema>

// --- requests -------------------------------------------------------------------

const productFields = {
  title: z.string().trim().min(3).max(120),
  description: z.string().trim().min(20).max(5000),
  categoryId: UuidSchema,
  /** ₹1 to ₹1,00,000. */
  pricePaise: z.number().int().min(100).max(10_000_000),
  compareAtPricePaise: PaiseSchema.optional(),
  craftTechnique: z.string().trim().max(60).optional(),
  materials: z.array(z.string().trim().min(1).max(40)).max(10).optional(),
  originRegion: z.string().trim().max(80).optional(),
  dimensionsCm: DimensionsCmSchema.optional(),
  weightGrams: z.number().int().min(1).max(50_000).optional(),
  careInstructions: z.string().trim().max(1000).optional(),
  makingTimeDays: z.number().int().min(0).max(365).optional(),
  taxRateBps: TaxRateBpsSchema.optional(),
  hsnCode: z
    .string()
    .regex(/^\d{4,8}$/, 'HSN code is 4 to 8 digits')
    .optional(),
}

const compareAtAbovePrice = (p: {
  pricePaise?: number | undefined
  compareAtPricePaise?: number | undefined
}) =>
  p.compareAtPricePaise === undefined || p.pricePaise === undefined || p.compareAtPricePaise > p.pricePaise

const compareAtMessage = {
  message: 'Compare-at price must be higher than the price',
  path: ['compareAtPricePaise'],
}

export const ProductUpsertSchema = z.object(productFields).refine(compareAtAbovePrice, compareAtMessage)
export type ProductUpsert = z.infer<typeof ProductUpsertSchema>

/**
 * PATCH body. compareAt is only checked here when both prices are sent;
 * the service re-checks against the stored price.
 */
export const ProductUpdateSchema = z
  .object(productFields)
  .partial()
  .refine(compareAtAbovePrice, compareAtMessage)
export type ProductUpdate = z.infer<typeof ProductUpdateSchema>

export const ProductSortSchema = z.enum(['relevance', 'newest', 'price_asc', 'price_desc', 'rating'])

/** minPrice/maxPrice are paise, like every other amount. */
export const ProductSearchQuerySchema = PageQuerySchema.extend({
  q: z.string().trim().min(1).max(100).optional(),
  category: SlugSchema.optional(),
  seller: SlugSchema.optional(),
  minPrice: z.coerce.number().int().nonnegative().optional(),
  maxPrice: z.coerce.number().int().nonnegative().optional(),
  inStock: z.stringbool().optional(),
  sort: ProductSortSchema.default('relevance'),
}).refine((q) => q.minPrice === undefined || q.maxPrice === undefined || q.minPrice <= q.maxPrice, {
  message: 'minPrice must not exceed maxPrice',
  path: ['minPrice'],
})
export type ProductSearchQuery = z.infer<typeof ProductSearchQuerySchema>

export const SellerProductsQuerySchema = CursorQuerySchema.extend({ status: ProductStatusSchema.optional() })
export type SellerProductsQuery = z.infer<typeof SellerProductsQuerySchema>

export const AdminProductsQuerySchema = SellerProductsQuerySchema.extend({ seller: SlugSchema.optional() })
export type AdminProductsQuery = z.infer<typeof AdminProductsQuerySchema>

export const InventoryBodySchema = z.object({ onHand: z.number().int().min(0).max(100_000) })
export type InventoryBody = z.infer<typeof InventoryBodySchema>

export const ImageContentTypeSchema = z.enum(['image/jpeg', 'image/png', 'image/webp'])

export const ImageUploadUrlBodySchema = z.object({
  contentType: ImageContentTypeSchema,
  /** At most 10 MB. */
  contentLength: z.number().int().min(1).max(10_485_760),
})
export type ImageUploadUrlBody = z.infer<typeof ImageUploadUrlBodySchema>

export const ImageConfirmBodySchema = z.object({
  storageKey: z.string().min(1).max(300),
  alt: z.string().trim().min(3).max(140),
})
export type ImageConfirmBody = z.infer<typeof ImageConfirmBodySchema>

export const ImagePatchBodySchema = z.object({
  alt: z.string().trim().min(3).max(140).optional(),
  position: z.number().int().min(0).max(7).optional(),
})
export type ImagePatchBody = z.infer<typeof ImagePatchBodySchema>

export const RejectBodySchema = z.object({ reason: ReasonSchema })
export type RejectBody = z.infer<typeof RejectBodySchema>

export const CategoryCreateBodySchema = z.object({
  name: z.string().trim().min(2).max(60),
  slug: SlugSchema.optional(),
  parentId: UuidSchema.nullable().optional(),
  description: z.string().trim().max(500).optional(),
  sortOrder: z.number().int().min(0).max(10_000).optional(),
})
export type CategoryCreateBody = z.infer<typeof CategoryCreateBodySchema>

export const CategoryUpdateBodySchema = CategoryCreateBodySchema.partial()
export type CategoryUpdateBody = z.infer<typeof CategoryUpdateBodySchema>

export const ReviewCreateBodySchema = z.object({
  rating: z.number().int().min(1).max(5),
  title: z.string().trim().max(100).optional(),
  body: z.string().trim().max(2000).optional(),
})
export type ReviewCreateBody = z.infer<typeof ReviewCreateBodySchema>

export const ReviewModerationBodySchema = z.object({ status: z.enum(['published', 'hidden']) })
export type ReviewModerationBody = z.infer<typeof ReviewModerationBodySchema>
