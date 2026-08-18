/**
 * OpenAPI description of the Splitwise-compatible surface.
 *
 * Documentation only. The handlers in v3.ts stay as they are: this file must
 * not grow a second write path or a stricter validator that would reject a
 * request Splitwise clients actually send (flattened `users__N__*` keys).
 *
 * Served at GET /api/sw/v3.0/openapi.json, unauthenticated - it is the frozen
 * wire, not anyone's ledger. See docs/SPLITWISE_COMPAT.md.
 */
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";

const ulid = z
  .string()
  .length(26)
  .describe("Crockford ULID string. A documented break from Splitwise integer ids.");

const decimal = z.string().describe('Decimal string, e.g. "25.00". Never a JSON number.');

const picture = z.object({
  small: z.string().nullable(),
  medium: z.string().nullable(),
  large: z.string().nullable(),
});

const userSchema = z.object({
  id: ulid,
  first_name: z.string(),
  last_name: z.string().nullable(),
  email: z
    .string()
    .describe(
      "Always truthy. Ghosts get a synthesised ghost-<ulid>@splitsmart.invalid address.",
    ),
  registration_status: z.enum(["dummy", "confirmed"]),
  picture,
  custom_picture: z.boolean(),
});

const currentUserSchema = userSchema.extend({
  default_currency: z.string(),
  locale: z.string(),
  date_format: z.string(),
  default_group_id: z.number(),
  notifications_read: z.string().nullable(),
  notifications_count: z.number(),
});

const balanceSchema = z.object({
  currency_code: z.string(),
  amount: decimal,
});

const friendSchema = userSchema.extend({
  balance: z.array(balanceSchema).describe("One entry per currency; zeros omitted."),
  groups: z.array(z.object({})).describe("Always empty; Toshl does not read this."),
  updated_at: z.string().nullable(),
});

const categorySchema = z.object({
  id: z.number().int().describe("Splitwise's real category id. Unchanged."),
  name: z.string(),
  icon: z.string().nullable(),
  icon_types: z.object({
    slim: z.object({ small: z.null(), large: z.null() }),
    square: z.object({ large: z.null(), xxlarge: z.null() }),
  }),
  subcategories: z.array(
    z.object({
      id: z.number().int(),
      name: z.string(),
      icon: z.string().nullable(),
      icon_types: z.object({
        slim: z.object({ small: z.null(), large: z.null() }),
        square: z.object({ large: z.null(), xxlarge: z.null() }),
      }),
    }),
  ),
});

const expenseUserSchema = z.object({
  user: userSchema,
  user_id: ulid,
  paid_share: decimal,
  owed_share: decimal,
  net_balance: decimal,
});

const expenseSchema = z.object({
  id: ulid,
  group_id: ulid.nullable(),
  description: z.string(),
  details: z.string().nullable(),
  payment: z.boolean(),
  cost: decimal,
  currency_code: z.string(),
  date: z.string(),
  category: z.object({
    id: z.number().int().nullable(),
    name: z.string(),
  }),
  created_at: z.string(),
  updated_at: z.string(),
  deleted_at: z
    .string()
    .nullable()
    .describe("Tombstones are returned, not filtered. Clients drop them."),
  created_by: userSchema.nullable(),
  repayments: z.array(
    z.object({
      from: ulid,
      to: ulid,
      amount: decimal,
    }),
  ),
  users: z.array(expenseUserSchema),
  receipt: z.object({ large: z.null(), original: z.null() }),
  comments_count: z.number(),
  expense_bundle_id: z.null(),
  repeats: z.literal(false),
  repeat_interval: z.null(),
  email_reminder: z.boolean(),
  email_reminder_in_advance: z.number(),
  next_repeat: z.null(),
  friendship_id: z.null(),
  creation_method: z.string(),
  transaction_method: z.string(),
  transaction_confirmed: z.boolean(),
});

const json = <T extends z.ZodType>(schema: T, description: string) => ({
  content: { "application/json": { schema } },
  description,
});

const bearer = [{ Bearer: [] }];

const getCurrentUser = createRoute({
  method: "get",
  path: "/get_current_user",
  tags: ["compat"],
  security: bearer,
  responses: {
    200: json(z.object({ user: currentUserSchema }), "The authenticated user"),
    401: json(z.object({ error: z.string() }), "Missing or invalid bearer token"),
  },
});

const getFriends = createRoute({
  method: "get",
  path: "/get_friends",
  tags: ["compat"],
  security: bearer,
  responses: {
    200: json(z.object({ friends: z.array(friendSchema) }), "Derived friends of the caller"),
    401: json(z.object({ error: z.string() }), "Missing or invalid bearer token"),
  },
});

const getFriend = createRoute({
  method: "get",
  path: "/get_friend/{id}",
  tags: ["compat"],
  security: bearer,
  request: {
    params: z.object({ id: ulid }),
  },
  responses: {
    200: json(z.object({ friend: friendSchema }), "One friend"),
    400: json(z.object({ error: z.string() }), "Invalid id"),
    401: json(z.object({ error: z.string() }), "Missing or invalid bearer token"),
    404: json(z.object({ error: z.string() }), "Unknown friend"),
  },
});

const getCategories = createRoute({
  method: "get",
  path: "/get_categories",
  tags: ["compat"],
  security: bearer,
  responses: {
    200: json(
      z.object({ categories: z.array(categorySchema) }),
      "Two-level tree. Clients use subcategory ids as category_id.",
    ),
    401: json(z.object({ error: z.string() }), "Missing or invalid bearer token"),
  },
});

const getExpenses = createRoute({
  method: "get",
  path: "/get_expenses",
  tags: ["compat"],
  security: bearer,
  request: {
    query: z.object({
      friend_id: ulid.optional(),
      group_id: ulid.optional(),
      dated_after: z.string().optional(),
      dated_before: z.string().optional(),
      limit: z.string().optional(),
      offset: z.string().optional(),
    }),
  },
  responses: {
    200: json(
      z.object({ expenses: z.array(expenseSchema) }),
      "Includes deleted_at tombstones. Clients filter them.",
    ),
    401: json(z.object({ error: z.string() }), "Missing or invalid bearer token"),
  },
});

const createExpenseBody = z
  .object({
    cost: decimal,
    description: z.string().optional(),
    details: z.string().optional().nullable(),
    currency_code: z.string().optional(),
    date: z.string().optional(),
    group_id: ulid.optional().nullable(),
    category_id: z.number().int().optional().nullable(),
  })
  .passthrough()
  .describe(
    "Also accepts Splitwise's flattened users__N__user_id / users__N__paid_share / users__N__owed_share keys.",
  );

const createExpense = createRoute({
  method: "post",
  path: "/create_expense",
  tags: ["compat"],
  security: bearer,
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: createExpenseBody } },
    },
  },
  responses: {
    200: json(
      z.object({
        expenses: z.array(expenseSchema),
        errors: z.object({}).describe("Empty object on success"),
      }),
      "Created expense, echoed in the get_expenses shape",
    ),
    400: json(
      z.object({
        expenses: z.array(z.object({})).describe("Always empty on validation failure"),
        errors: z.object({ base: z.array(z.string()) }),
      }),
      "Validation failure. Splitwise returns 200 with errors; we return 4xx AND errors.",
    ),
    401: json(z.object({ error: z.string() }), "Missing or invalid bearer token"),
  },
});

/**
 * Registry-only: paths are registered without handlers so the spec cannot
 * grow a second write path. Real handlers stay in v3.ts.
 */
const spec = new OpenAPIHono();

function document(route: ReturnType<typeof createRoute>): void {
  spec.openAPIRegistry.registerPath(route);
}

document(getCurrentUser);
document(getFriends);
document(getFriend);
document(getCategories);
document(getExpenses);
document(createExpense);

spec.openAPIRegistry.registerComponent("securitySchemes", "Bearer", {
  type: "http",
  scheme: "bearer",
  description: "API token minted in Settings. Authorization: Bearer <token>",
});

export function compatOpenApiDocument() {
  return spec.getOpenAPIDocument({
    openapi: "3.0.0",
    info: {
      title: "SplitSmart Splitwise-compatible API",
      version: "3.0",
      description:
        "The six endpoints splitwise-to-toshl calls. Entity ids are ULID strings, " +
        "not Splitwise integers. Money is decimal strings. See docs/SPLITWISE_COMPAT.md.",
    },
    servers: [{ url: "/api/sw/v3.0" }],
  });
}
