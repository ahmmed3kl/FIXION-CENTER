const express = require("express");
const { platformAuthMiddleware } = require("../middleware/platformAuth");
const { listOperations, summary } = require("../services/platformSyncQuery");
const router = express.Router({ mergeParams: true });
router.use(platformAuthMiddleware);
router.get("/summary", async (req, res, next) => { try { res.json({ summary: await summary(req.query, req.params.centerId) }); } catch (e) { next(e); } });
router.get("/", async (req, res, next) => { try { res.json(await listOperations(req.query, req.params.centerId)); } catch (e) { next(e); } });
router.get("/:operationId", async (req, res, next) => { try { const result = await listOperations({ ...req.query, operationId: req.params.operationId, pageSize: 1 }, req.params.centerId); const operation = result.items.find(item => item.operation_id === req.params.operationId); if (!operation) return res.status(404).json({ error: { code: "NOT_FOUND", userMessage: "عملية المزامنة غير موجودة." } }); res.json({ operation }); } catch (e) { next(e); } });
module.exports = router;
