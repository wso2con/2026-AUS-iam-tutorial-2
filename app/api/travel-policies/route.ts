import { NextRequest, NextResponse } from "next/server";
import { getTravelPolicy, upsertTravelPolicy, deleteTravelPolicy, TravelPolicy } from "../../lib/db/queries/travel-policies";
import { requireScope } from "../../lib/auth/guard";
import { Scope } from "../../lib/auth/utils";

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const [, payload] = token.split(".");

  if (!payload) {
    return null;
  }

  try {
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function logAuthorizationHeader(request: NextRequest) {
  const authorization = request.headers.get("authorization");
  const token = authorization?.startsWith("Bearer ") ? authorization.slice(7) : "";
  const payload = token ? decodeJwtPayload(token) : null;
  const actor = typeof payload?.act === "object" && payload.act !== null
    ? (payload.act as Record<string, unknown>).sub
    : undefined;

  console.error("[travel-policies]", request.method, request.nextUrl.pathname, {
    actor: typeof actor === "string" ? actor : null,
    sub: typeof payload?.sub === "string" ? payload.sub : null,
  });
}

export async function GET(request: NextRequest) {
  logAuthorizationHeader(request);

  const auth = await requireScope(request, [Scope.TRAVEL_POLICY_VIEW]);
  if (auth instanceof NextResponse) return auth;

  const policy = getTravelPolicy(auth.claims.orgId);

  return NextResponse.json({ policy });
}

type UpsertBody = {
  domestic_cabin?: string;
  max_flight_price?: number;
  price_cap_percent?: number;
};

async function parseUpsertBody(request: NextRequest): Promise<UpsertBody | NextResponse> {
  try {
    return (await request.json()) as UpsertBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
}

export async function POST(request: NextRequest) {
  logAuthorizationHeader(request);

  const auth = await requireScope(request, [Scope.TRAVEL_POLICY_CREATE]);
  if (auth instanceof NextResponse) return auth;

  const body = await parseUpsertBody(request);
  if (body instanceof NextResponse) return body;

  const { domestic_cabin, max_flight_price, price_cap_percent } = body;
  const { orgId } = auth.claims;

  const created: Omit<TravelPolicy, "id" | "org_id" | "updated_at"> = {
    domestic_cabin: domestic_cabin ?? "Economy",
    max_flight_price: max_flight_price ?? 500,
    price_cap_percent: price_cap_percent ?? 20,
  };

  const policy = upsertTravelPolicy(orgId, created);

  return NextResponse.json({ policy }, { status: 201 });
}

export async function PUT(request: NextRequest) {
  logAuthorizationHeader(request);

  const auth = await requireScope(request, [Scope.TRAVEL_POLICY_UPDATE]);
  if (auth instanceof NextResponse) return auth;

  const body = await parseUpsertBody(request);
  if (body instanceof NextResponse) return body;

  const { domestic_cabin, max_flight_price, price_cap_percent } = body;
  const { orgId } = auth.claims;

  const defaults = getTravelPolicy(orgId);

  const updated: Omit<TravelPolicy, "id" | "org_id" | "updated_at"> = {
    domestic_cabin: domestic_cabin ?? defaults?.domestic_cabin ?? "Economy",
    max_flight_price: max_flight_price ?? defaults?.max_flight_price ?? 500,
    price_cap_percent: price_cap_percent ?? defaults?.price_cap_percent ?? 20,
  };

  const policy = upsertTravelPolicy(orgId, updated);

  return NextResponse.json({ policy });
}

export async function DELETE(request: NextRequest) {
  logAuthorizationHeader(request);

  const auth = await requireScope(request, [Scope.TRAVEL_POLICY_DELETE]);
  if (auth instanceof NextResponse) return auth;

  deleteTravelPolicy(auth.claims.orgId);

  return new NextResponse(null, { status: 204 });
}
