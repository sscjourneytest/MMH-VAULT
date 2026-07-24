export default {
  async fetch(request, env) {
    const SUPABASE_URL = "https://duqmejyypqgkrjlpplrz.supabase.co";
    const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImR1cW1lanl5cHFna3JqbHBwbHJ6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzE2MDIyNTAsImV4cCI6MjA4NzE3ODI1MH0.aAIITdr-BS-D-TJHY1fEkqgN4CRVwsyz90d2I9IrhVc";

    const allowedOrigins = [
      "https://mockmatrixhub.in",
      "https://www.mockmatrixhub.in",
      "https://mockmatrixhub.pages.dev",
    ];
    const requestOrigin = request.headers.get("Origin");
    const allowOrigin = allowedOrigins.includes(requestOrigin) ? requestOrigin : allowedOrigins[0];

    const corsHeaders = {
      "Access-Control-Allow-Origin": allowOrigin,
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, PATCH, OPTIONS",
      "Access-Control-Allow-Headers": "Authorization, Content-Type, apikey, x-client-info, x-supabase-auth, x-supabase-api-version, preferred_alphabets, x-address-t, accept-profile, content-profile, Prefer, x-razorpay-signature",
      "Access-Control-Allow-Credentials": "true",
      "Access-Control-Max-Age": "86400",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    const url = new URL(request.url);

    // ---------------------------------------------------------
    // NEW: Razorpay routes — handled here, never forwarded to Supabase
    // ---------------------------------------------------------
    if (url.pathname === "/create-order" && request.method === "POST") {
      return handleCreateOrder(request, env, SUPABASE_URL, SUPABASE_ANON_KEY, corsHeaders);
    }
    if (url.pathname === "/validate-coupon" && request.method === "POST") {
      return handleValidateCoupon(request, env, SUPABASE_URL, corsHeaders);
    }
    if (url.pathname === "/razorpay-webhook" && request.method === "POST") {
      return handleWebhook(request, env, SUPABASE_URL, corsHeaders);
    }
    if (url.pathname === "/admin-grant-premium" && request.method === "POST") {
      return handleAdminGrant(request, env, SUPABASE_URL, SUPABASE_ANON_KEY, corsHeaders);
    }

    // ---------------------------------------------------------
    // EXISTING: generic Supabase reverse proxy (unchanged)
    // ---------------------------------------------------------
    const targetUrl = `${SUPABASE_URL}${url.pathname}${url.search}`;
    const newHeaders = new Headers(request.headers);
    newHeaders.set("Host", "duqmejyypqgkrjlpplrz.supabase.co");

    try {
      const response = await fetch(targetUrl, {
        method: request.method,
        headers: newHeaders,
        body: request.method !== "GET" && request.method !== "HEAD" ? request.body : null,
        redirect: "follow",
      });

      const proxyResponse = new Response(response.body, response);
      Object.keys(corsHeaders).forEach((h) => proxyResponse.headers.set(h, corsHeaders[h]));
      proxyResponse.headers.delete("content-security-policy");

      return proxyResponse;
    } catch (err) {
      return new Response("Proxy Error: " + err.message, { status: 502, headers: corsHeaders });
    }
  },
};

// ==================================================================
// Helpers
// ==================================================================

function json(data, status, corsHeaders) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// Confirms the logged-in user's identity from their Supabase access token.
// Never trust a user_id sent directly from the browser.
async function getUserFromToken(request, SUPABASE_URL, SUPABASE_ANON_KEY) {
  const authHeader = request.headers.get("Authorization");
  if (!authHeader) return null;

  const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: authHeader,
    },
  });
  if (!res.ok) return null;
  return await res.json(); // { id, email, ... }
}

async function supabaseServiceRequest(env, SUPABASE_URL, path, method, body) {
  const res = await fetch(`${SUPABASE_URL}${path}`, {
    method,
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res;
}

// Looks up pricing + (optional) coupon and returns the final amount,
// rounded to the nearest whole rupee.
async function computeFinalAmount(env, SUPABASE_URL, planName, couponCode) {
  const priceRes = await supabaseServiceRequest(
    env, SUPABASE_URL,
    `/rest/v1/pricing?plan_name=eq.${encodeURIComponent(planName)}&is_active=eq.true&select=*`,
    "GET"
  );
  const priceRows = await priceRes.json();
  if (!priceRows || priceRows.length === 0) return { error: "Invalid or inactive plan" };
  const plan = priceRows[0];

  let discountPercent = 0;
  let coupon = null;

  if (couponCode) {
    const nowIso = new Date().toISOString();
    const couponRes = await supabaseServiceRequest(
      env, SUPABASE_URL,
      `/rest/v1/coupons?code=eq.${encodeURIComponent(couponCode)}&is_active=eq.true` +
      `&or=(valid_until.is.null,valid_until.gte.${nowIso})&select=*`,
      "GET"
    );
    const couponRows = await couponRes.json();
    if (!couponRows || couponRows.length === 0) {
      return { error: "Invalid, inactive, or expired coupon" };
    }
    coupon = couponRows[0];
    discountPercent = coupon.discount_percent;
  }

  const rawFinal = plan.offer_price - (plan.offer_price * discountPercent) / 100;
  const finalAmount = Math.round(rawFinal); // always nearest integer

  return { plan, coupon, finalAmount };
}

// ==================================================================
// Route handlers
// ==================================================================

async function handleValidateCoupon(request, env, SUPABASE_URL, corsHeaders) {
  try {
    const { plan_name, coupon_code } = await request.json();
    if (!plan_name || !coupon_code) {
      return json({ valid: false, error: "Missing plan_name or coupon_code" }, 400, corsHeaders);
    }

    const result = await computeFinalAmount(env, SUPABASE_URL, plan_name, coupon_code);
    if (result.error) {
      return json({ valid: false, error: result.error }, 400, corsHeaders);
    }

    return json(
      {
        valid: true,
        discount_percent: result.coupon.discount_percent,
        final_amount: result.finalAmount,
      },
      200,
      corsHeaders
    );
  } catch (err) {
    return json({ valid: false, error: err.message }, 500, corsHeaders);
  }
}

async function handleCreateOrder(request, env, SUPABASE_URL, SUPABASE_ANON_KEY, corsHeaders) {
  try {
    const user = await getUserFromToken(request, SUPABASE_URL, SUPABASE_ANON_KEY);
    if (!user || !user.id) {
      return json({ error: "Not authenticated" }, 401, corsHeaders);
    }

    const { plan_name, coupon_code } = await request.json();
    if (!plan_name) {
      return json({ error: "Missing plan_name" }, 400, corsHeaders);
    }

    const result = await computeFinalAmount(env, SUPABASE_URL, plan_name, coupon_code);
    if (result.error) {
      return json({ error: result.error }, 400, corsHeaders);
    }

    const { plan, finalAmount } = result;

    // Razorpay order — amount in paise
    const orderRes = await fetch("https://api.razorpay.com/v1/orders", {
      method: "POST",
      headers: {
        Authorization: "Basic " + btoa(`${env.RAZORPAY_KEY_ID}:${env.RAZORPAY_KEY_SECRET}`),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        amount: finalAmount * 100,
        currency: "INR",
        notes: {
          user_id: user.id,
          plan_name: plan.plan_name,
          validity_days: String(plan.validity_days),
          coupon_code: coupon_code || "",
        },
      }),
    });

    const order = await orderRes.json();
    if (!orderRes.ok) {
      return json({ error: "Razorpay order creation failed", details: order }, 502, corsHeaders);
    }

    return json(
      {
        order_id: order.id,
        amount: finalAmount,
        currency: "INR",
        key_id: env.RAZORPAY_KEY_ID, // public, safe to expose
        plan_name: plan.plan_name,
      },
      200,
      corsHeaders
    );
  } catch (err) {
    return json({ error: err.message }, 500, corsHeaders);
  }
}

async function handleWebhook(request, env, SUPABASE_URL, corsHeaders) {
  try {
    const rawBody = await request.text();
    const signature = request.headers.get("x-razorpay-signature");

    const isValid = await verifySignature(rawBody, signature, env.RAZORPAY_WEBHOOK_SECRET);
    if (!isValid) {
      return json({ error: "Invalid signature" }, 400, corsHeaders);
    }

    const payload = JSON.parse(rawBody);

    if (payload.event !== "payment.captured") {
      return json({ status: "ignored" }, 200, corsHeaders); // 200 so Razorpay doesn't retry
    }

    const payment = payload.payload.payment.entity;
    const orderId = payment.order_id;
    const paymentId = payment.id;
    const notes = payment.notes || {};
    const amountPaid = payment.amount / 100;

    // Idempotency check — Razorpay may retry the same event
    const existingRes = await supabaseServiceRequest(
      env, SUPABASE_URL,
      `/rest/v1/payments?order_id=eq.${encodeURIComponent(orderId)}&select=id`,
      "GET"
    );
    const existing = await existingRes.json();
    if (existing && existing.length > 0) {
      return json({ status: "already processed" }, 200, corsHeaders);
    }

    // Insert payment record
    await supabaseServiceRequest(env, SUPABASE_URL, "/rest/v1/payments", "POST", {
      order_id: orderId,
      payment_id: paymentId,
      user_id: notes.user_id,
      amount_paid: amountPaid,
      coupon_code: notes.coupon_code || null,
    });

    // Update the user's profile
    const validityDays = parseInt(notes.validity_days || "365", 10);
    const expiresAt = new Date(Date.now() + validityDays * 24 * 60 * 60 * 1000).toISOString();

    await supabaseServiceRequest(
      env, SUPABASE_URL,
      `/rest/v1/profiles?id=eq.${encodeURIComponent(notes.user_id)}`,
      "PATCH",
      { is_paid: true, expires_at: expiresAt }
    );

    return json({ status: "ok" }, 200, corsHeaders);
  } catch (err) {
    return json({ error: err.message }, 500, corsHeaders);
  }
}

async function verifyRole(env, SUPABASE_URL, userId, allowedRoles) {
  const res = await supabaseServiceRequest(
    env, SUPABASE_URL,
    `/rest/v1/profiles?id=eq.${encodeURIComponent(userId)}&select=role`,
    "GET"
  );
  const rows = await res.json();
  if (!rows || rows.length === 0) return false;
  return allowedRoles.includes(rows[0].role);
}

async function handleAdminGrant(request, env, SUPABASE_URL, SUPABASE_ANON_KEY, corsHeaders) {
  try {
    const user = await getUserFromToken(request, SUPABASE_URL, SUPABASE_ANON_KEY);
    if (!user || !user.id) {
      return json({ error: "Not authenticated" }, 401, corsHeaders);
    }

    // Only 'owner' may directly grant premium — checked server-side,
    // never trust a role claim from the browser.
    const isOwner = await verifyRole(env, SUPABASE_URL, user.id, ["owner"]);
    if (!isOwner) {
      return json({ error: "Forbidden — owner access required" }, 403, corsHeaders);
    }

    const { email, validity_days } = await request.json();
    if (!email || !validity_days) {
      return json({ error: "Missing email or validity_days" }, 400, corsHeaders);
    }

    const profileRes = await supabaseServiceRequest(
      env, SUPABASE_URL,
      `/rest/v1/profiles?email=eq.${encodeURIComponent(email)}&select=id,username`,
      "GET"
    );
    const profiles = await profileRes.json();
    if (!profiles || profiles.length === 0) {
      return json({ error: "No user found with that email" }, 404, corsHeaders);
    }
    const targetId = profiles[0].id;

    const expiresAt = new Date(Date.now() + Number(validity_days) * 24 * 60 * 60 * 1000).toISOString();

    const updateRes = await supabaseServiceRequest(
      env, SUPABASE_URL,
      `/rest/v1/profiles?id=eq.${encodeURIComponent(targetId)}`,
      "PATCH",
      { is_paid: true, expires_at: expiresAt }
    );

    if (!updateRes.ok) {
      const errDetails = await updateRes.json();
      return json({ error: "Failed to update profile", details: errDetails }, 502, corsHeaders);
    }

    return json({ status: "ok", username: profiles[0].username, expires_at: expiresAt }, 200, corsHeaders);
  } catch (err) {
    return json({ error: err.message }, 500, corsHeaders);
  }
}

async function verifySignature(body, signature, secret) {
  if (!signature || !secret) return false;

  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sigBuffer = await crypto.subtle.sign("HMAC", key, enc.encode(body));
  const expectedHex = [...new Uint8Array(sigBuffer)].map((b) => b.toString(16).padStart(2, "0")).join("");

  return expectedHex === signature;
}

