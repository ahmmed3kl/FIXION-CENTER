const express = require("express");
const db = require("../db");
const { AppError } = require("../middleware/errorHandler");
const { platformAuthMiddleware } = require("../middleware/platformAuth");
const { record } = require("../services/auditService");
const router = express.Router({ mergeParams: true });
router.use(platformAuthMiddleware);

const safe =
  "d.id,d.center_id,d.user_id,d.device_name,d.platform,d.app_version,d.status,d.last_seen_at,d.created_at,d.updated_at";
const accountJoin = `LEFT JOIN users u ON u.id=d.user_id
  AND (u.center_id=d.center_id OR EXISTS (
    SELECT 1 FROM user_centers uc
    WHERE uc.user_id=u.id AND uc.center_id=d.center_id
  ))`;

router.get("/", async (req, res, next) => {
  try {
    const result = await db.query(
      `SELECT ${safe},u.full_name,u.email AS user_email,
              (SELECT COUNT(*)::int FROM server_sync_operations o
               WHERE o.device_id=d.id AND o.status='rejected') failed_operations,
              0::int pending_operations
       FROM devices d ${accountJoin}
       WHERE d.center_id=$1
       ORDER BY d.last_seen_at DESC NULLS LAST`,
      [req.params.centerId],
    );
    res.json({
      items: result.rows,
      pagination: {
        page: 1,
        pageSize: result.rows.length,
        total: result.rows.length,
        totalPages: 1,
      },
    });
  } catch (error) {
    next(error);
  }
});

router.get("/:deviceId", async (req, res, next) => {
  try {
    const result = await db.query(
      `SELECT ${safe},u.full_name,u.email AS user_email
       FROM devices d ${accountJoin}
       WHERE d.center_id=$1 AND d.id=$2`,
      [req.params.centerId, req.params.deviceId],
    );
    if (!result.rows[0]) {
      throw new AppError("NOT_FOUND", "Device not found.", "الجهاز غير موجود.", 404);
    }
    res.json({ device: result.rows[0] });
  } catch (error) {
    next(error);
  }
});
async function setStatus(req,res,next,status){try{const old=await db.query("SELECT status,device_name,platform,app_version FROM devices WHERE center_id=$1 AND id=$2",[req.params.centerId,req.params.deviceId]);const r=await db.query(`UPDATE devices SET status=$1,updated_at=NOW() WHERE center_id=$2 AND id=$3 RETURNING ${safe}`,[status,req.params.centerId,req.params.deviceId]);if(!r.rows[0])throw new AppError("NOT_FOUND","Device not found.","الجهاز غير موجود.",404);const action=status==="active"?"device.activated":req.path.endsWith("/revoke")?"device.revoked":"device.deactivated";await record({actor:req.platformAdmin,centerId:req.params.centerId,action,entityType:"device",entityId:req.params.deviceId,before:old.rows[0],after:{status:r.rows[0].status,device_name:r.rows[0].device_name,platform:r.rows[0].platform,app_version:r.rows[0].app_version}});res.json({device:r.rows[0]});}catch(e){next(e);}}router.post("/:deviceId/deactivate",(q,s,n)=>setStatus(q,s,n,"revoked"));router.post("/:deviceId/activate",(q,s,n)=>setStatus(q,s,n,"active"));router.post("/:deviceId/revoke",(q,s,n)=>setStatus(q,s,n,"revoked"));module.exports=router;
