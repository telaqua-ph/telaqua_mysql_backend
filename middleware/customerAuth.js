import { authenticateCustomerRequest } from "../services/customerAuthService.js";

export async function requireCustomerAuth(req, res, next) {
  try {
    req.customer = await authenticateCustomerRequest(req);
    return next();
  } catch (error) {
    return res.status(error?.statusCode || 401).json({
      success: false,
      message: error?.message || "Unauthorized",
    });
  }
}
