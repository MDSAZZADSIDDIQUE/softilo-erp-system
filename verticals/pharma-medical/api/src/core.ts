// The one seam between this edition and the shared core API. Everything the pharma module
// reuses from apps/api comes through here, so a core refactor only needs fixing in one place.
export { buildServer, type ModuleRegistrar } from "../../../../apps/api/src/server.js";
export { inTenant, requireCtx, requireWrite, type Ctx } from "../../../../apps/api/src/lib/context.js";
export { AppError, notFound, unprocessable } from "../../../../apps/api/src/lib/errors.js";
export { audit } from "../../../../apps/api/src/lib/ledger.js";
export { IdParams, isoDate, quantity, rate, today, unitPrice, uuid, vatCode } from "../../../../apps/api/src/lib/schemas.js";
export { receiveGoods } from "../../../../apps/api/src/modules/purchasing.js";
export { createSalesDocument, InvoiceInput } from "../../../../apps/api/src/modules/sales.js";
