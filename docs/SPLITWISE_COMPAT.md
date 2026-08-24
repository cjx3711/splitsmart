# Splitwise API compatibility

**Dropped.** `/api/sw/v3.0` is not mounted.

There used to be a Splitwise v3.0 shim so existing clients could keep working
after changing only the base URL. Native `/api/v1` already had the same
information (and more). Maintaining a frozen, ugly wire next to that one was
pointless once recoding a client against `/api/v1` became an afternoon of agent
work.

The API is documented at [`/docs`](/docs). Category ids are still Splitwise's
integers (`src/db/categories.ts`); entity ids are still ULIDs
(`docs/ULIDS.md`). Import from Splitwise is unchanged.
