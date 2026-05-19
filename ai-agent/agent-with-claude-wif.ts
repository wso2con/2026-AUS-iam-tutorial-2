/*
Copyright (c) 2026, WSO2 LLC. (http://www.wso2.com). All Rights Reserved.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

   http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

import { createServer, type ServerResponse } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import type { Duplex } from "node:stream";

import { AsgardeoJavaScriptClient } from "@asgardeo/javascript";
import { ChatAnthropic } from "@langchain/anthropic";
import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { MultiServerMCPClient } from "@langchain/mcp-adapters";
import dotenv from "dotenv";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

dotenv.config({
    path: resolve(__dirname, ".env"),
});

type LogLevel = "debug" | "info" | "warn" | "error" | "fatal";

const LOG_LEVEL_ORDER: Record<LogLevel, number> = {
    debug: 10,
    info: 20,
    warn: 30,
    error: 40,
    fatal: 50,
};

type LogContext = Record<string, unknown>;

function normalizeLogLevel(value: string | undefined): LogLevel {
    return value === "debug" || value === "info" || value === "warn" || value === "error" || value === "fatal"
        ? value
        : "info";
}

function redactLogValue(key: string, value: unknown): unknown {
    if (
        key.toLowerCase().includes("authorization") ||
        key.toLowerCase().includes("token") ||
        key.toLowerCase().includes("secret")
    ) {
        return "[redacted]";
    }

    if (value instanceof Error) {
        return summarizeError(value);
    }

    return value;
}

function formatLogContext(context: LogContext) {
    const entries = Object.entries(context)
        .filter(([, value]) => value !== undefined)
        .map(([key, value]) => {
            const redactedValue = redactLogValue(key, value);
            const formattedValue = typeof redactedValue === "string"
                ? redactedValue.replace(/\s+/g, " ")
                : JSON.stringify(redactedValue);

            return `${key}=${formattedValue}`;
        });

    return entries.length > 0 ? ` ${entries.join(" ")}` : "";
}

function createLogger(context: LogContext = {}) {
    const configuredLevel = normalizeLogLevel(process.env.LOG_LEVEL);

    function write(level: LogLevel, first: string | LogContext, second?: string) {
        if (LOG_LEVEL_ORDER[level] < LOG_LEVEL_ORDER[configuredLevel]) {
            return;
        }

        const message = typeof first === "string" ? first : second || "";
        const childContext = typeof first === "string" ? {} : first;
        const timestamp = new Date().toISOString();
        const contextText = formatLogContext({ ...context, ...childContext });
        const line = `${timestamp} ${level.toUpperCase()} ${message}${contextText}`;

        if (level === "warn") {
            console.warn(line);
        } else if (level === "error" || level === "fatal") {
            console.error(line);
        } else {
            console.log(line);
        }
    }

    return {
        child: (childContext: LogContext) => createLogger({ ...context, ...childContext }),
        debug: (first: string | LogContext, second?: string) => write("debug", first, second),
        info: (first: string | LogContext, second?: string) => write("info", first, second),
        warn: (first: string | LogContext, second?: string) => write("warn", first, second),
        error: (first: string | LogContext, second?: string) => write("error", first, second),
        fatal: (first: string | LogContext, second?: string) => write("fatal", first, second),
    };
}

const logger = createLogger();

function summarizeError(error: Error) {
    const errorLike = error as Error & {
        code?: string;
        statusCode?: number;
        statusText?: string;
    };
    const collapsedMessage = error.message.replace(/\s+/g, " ");
    const truncatedMessage = collapsedMessage.length > 500
        ? `${collapsedMessage.slice(0, 500)}...`
        : collapsedMessage;

    return [
        error.name,
        errorLike.code,
        errorLike.statusCode ? `status=${errorLike.statusCode}` : "",
        errorLike.statusText,
        truncatedMessage,
    ].filter(Boolean).join(" ");
}

function getEnv(name: string) {
    return process.env[name]?.trim() || "";
}

const asgardeoConfig = {
    afterSignInUrl: getEnv("REDIRECT_URI"),
    clientId: getEnv("CLIENT_ID"),
    clientSecret: getEnv("CLIENT_SECRET"),
    baseUrl: getEnv("ASGARDEO_BASE_URL").replace(/\/$/, ""),
};

const agentConfig = {
    agentID: getEnv("AGENT_ID"),
    agentSecret: getEnv("AGENT_SECRET"),
};

const wifConfig = {
    federationRuleId: getEnv("ANTHROPIC_FEDERATION_RULE_ID"),
    organizationId: getEnv("ANTHROPIC_ORGANIZATION_ID"),
    serviceAccountId: getEnv("ANTHROPIC_SERVICE_ACCOUNT_ID"),
    workspaceId: getEnv("ANTHROPIC_WORKSPACE_ID"),
    identityToken: getEnv("ANTHROPIC_IDENTITY_TOKEN"),
    identityTokenFile: getEnv("ANTHROPIC_IDENTITY_TOKEN_FILE"),
};

const DEFAULT_ORGANIZATION_API_SCOPES = [
    "openid",
    "internal_org_user_mgt_create",
    "internal_org_user_mgt_list",
    "internal_org_user_mgt_update",
    "internal_org_role_mgt_view",
    "internal_org_role_mgt_users_update",
    "create_travel_policy",
    "view_travel_policy",
    "update_travel_policy",
    "delete_travel_policy",
    "view_booking",
    "create_booking",
    "delete_booking",
].join(" ");

const appBaseUrl = (getEnv("APP_BASE_URL") || "http://localhost:3000").replace(/\/$/, "");
const autonomousTravelPolicyScopes = getEnv("AGENT_TRAVEL_POLICY_SCOPES") || "view_travel_policy";
const delegatedBookingScopes = getEnv("DELEGATED_BOOKING_SCOPES") || "create_booking";
const delegatedUserOrganizationScopes = getEnv("DELEGATED_USER_ORG_SCOPES") || DEFAULT_ORGANIZATION_API_SCOPES;
const oboRedirectUri = getEnv("OBO_REDIRECT_URI") || new URL("/obo/callback", asgardeoConfig.afterSignInUrl).toString();
const oboResource = getEnv("OBO_RESOURCE");

type WifTokenCache = {
    token: string;
    expiresAt: number;
};

let wifTokenCache: WifTokenCache | null = null;

async function exchangeWifToken(): Promise<string> {
    const identityToken = wifConfig.identityToken
        || readFileSync(wifConfig.identityTokenFile, "utf-8").trim();
    const response = await fetch("https://api.anthropic.com/v1/oauth/token", {
        body: JSON.stringify({
            assertion: identityToken,
            federation_rule_id: wifConfig.federationRuleId,
            grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
            organization_id: wifConfig.organizationId,
            service_account_id: wifConfig.serviceAccountId,
            workspace_id: wifConfig.workspaceId,
        }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
        signal: AbortSignal.timeout(30000),
    });
    const body = await response.json().catch(() => ({})) as {
        access_token?: string;
        expires_in?: number;
        error?: string;
        error_description?: string;
    };

    if (!response.ok || !body.access_token) {
        throw new Error(body.error_description ?? body.error ?? "WIF token exchange failed.");
    }

    const expiresIn = body.expires_in ?? 3600;

    wifTokenCache = {
        token: body.access_token,
        expiresAt: Date.now() + (expiresIn - 60) * 1000,
    };
    logger.info("WIF access token obtained from Anthropic");

    return body.access_token;
}

async function getWifToken(): Promise<string> {
    if (wifTokenCache && Date.now() < wifTokenCache.expiresAt) {
        return wifTokenCache.token;
    }

    logger.info("Requesting new WIF access token from Anthropic");

    return exchangeWifToken();
}

async function createModel(): Promise<ChatAnthropic> {
    const apiKey = await getWifToken();

    return new ChatAnthropic({
        apiKey,
        model: getEnv("CLAUDE_MODEL_NAME") || getEnv("MODEL_NAME") || "claude-sonnet-4-6",
        temperature: null,
        topP: 1,
    });
}

const agentPrompt = [
    "You are Wayfinder Enterprise's AI assistant for business travel administrators and employees.",
    "Help users understand travel policies, organization users and roles, and available flight options by using the available MCP tools.",
    "Do not mention Asgardeo, OAuth, OBO, access tokens, scopes, requested_actor, or other identity-platform implementation details to the user.",
    "Refer to sign-in and consent as Wayfinder authorization.",
    "Use autonomous agent access for read-only operational questions such as showing travel policies, roles, users, and fare options.",
    "Use delegated user access for user-requested changes such as updating policy fields or inviting employees.",
    "For any request to show, explain, use, or evaluate travel policy, call get_travel_policy before answering.",
    "If no travel policy is configured for the organization, do not block flight search or booking; treat all available flights as allowed.",
    "When a logged-out user asks to book a flight, ask for their organization name before starting delegated authorization.",
    "Before searching for flights, always confirm the origin city, destination city, and preferred travel date with the user. Do not call search_enterprise_flights until you have at least an origin and destination from the user.",
    "If the user expresses intent to book a flight but has not provided origin, destination, or travel date, ask for all missing details in a single follow-up message before proceeding.",
    "When a user asks to book a flight and organization context is available, start delegated authorization, then call get_current_access_context, call get_travel_policy, find the matching flight with search_enterprise_flights, and call create_flight_booking only after the flight is clear.",
    "Never call create_flight_booking in a turn where get_travel_policy has not already been called.",
    "If a booking request does not identify a single flight, ask a concise follow-up question instead of guessing.",
    "When a user asks to update a travel policy, call update_travel_policy with only the fields the user clearly asked to change.",
    "When a user asks to invite an employee, call invite_organization_user only when an email address is provided.",
    "Respond in a warm, natural, and helpful tone — like a knowledgeable travel assistant, not a system report.",
    "When presenting results, briefly acknowledge the user's request before showing data, and always end with a clear next step or question.",
    "Use markdown formatting such as bold text, tables, and bullet points to make responses easy to read.",
    "Never present raw data dumps; always frame results with context and a natural conversational wrap.",
    "Never show auth request IDs, access tokens, raw JSON, or other technical identifiers to the user.",
].join("\n");

type ChatMessage = {
    role: "user" | "assistant" | "system";
    content: string;
};

type ChatRequest = {
    message?: unknown;
    messages?: unknown;
    mode?: unknown;
    orgId?: unknown;
    orgName?: unknown;
};

type ChatInvocationMode = "agent" | "user";

type ParsedChatRequest = {
    messages: ChatMessage[];
    mode?: ChatInvocationMode;
    orgId?: string;
    orgName?: string;
};

type TravelPolicy = {
    domestic_cabin: string;
    max_flight_price: number;
    price_cap_percent: number;
};

type Flight = {
    id: string;
    from_city: string;
    to_city: string;
    airline: string;
    departure_time: string;
    arrival_time: string;
    duration: string;
    stops: number;
    price: number;
    currency: string;
    cabin: string;
    dates: string;
    tags: string[];
};

type PolicyStatus = "in-policy" | "approval-required" | "out-of-policy";

type SuggestedFlight = Flight & {
    policyStatus: PolicyStatus;
    policyNotes: string[];
};

type BookingSearchCriteria = {
    departureDate?: string;
    from?: string;
    to?: string;
};

type AgentInvokeResult = {
    messages: Array<{ content?: unknown }>;
};

type RunnableAgent = {
    invoke: (input: { messages: ChatMessage[] }) => Promise<AgentInvokeResult>;
};

type AgentRuntime = {
    agent: RunnableAgent;
    client: MultiServerMCPClient;
    tools: ToolWithSchema[];
};

type RootAgentRuntime = {
    agentActorToken: string;
};

type PendingDelegation = {
    createdAt: number;
    flightId?: string;
    orgId?: string;
    request: ParsedChatRequest;
    socket: Duplex;
};

type WebSocketFrame = {
    opcode: number;
    payload: Buffer<ArrayBufferLike>;
};

const WEB_SOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

type ToolWithSchema = {
    name?: string;
    schema?: unknown;
    invoke?: (input: Record<string, unknown>) => Promise<unknown> | unknown;
};

function isToolNamed(tool: ToolWithSchema, name: string) {
    return tool.name === name || Boolean(tool.name?.endsWith(`_${name}`));
}

function parseChatRequest(payload: string): ParsedChatRequest {

    try {
        const request = JSON.parse(payload) as ChatRequest;
        const orgId = typeof request.orgId === "string" && request.orgId.trim()
            ? request.orgId.trim()
            : undefined;
        const explicitOrgName = typeof request.orgName === "string" && request.orgName.trim()
            ? request.orgName.trim()
            : undefined;
        const mode = request.mode === "agent" || request.mode === "user"
            ? request.mode
            : undefined;

        if (typeof request.message === "string" && request.message.trim()) {
            const messages = [{ role: "user" as const, content: request.message }];

            return {
                messages,
                mode,
                orgId,
                orgName: explicitOrgName ?? inferOrganizationName(messages),
            };
        }

        if (Array.isArray(request.messages)) {
            const messages = request.messages.filter((message): message is ChatMessage => {
                if (typeof message !== "object" || message === null) {
                    return false;
                }

                const candidate = message as Partial<ChatMessage>;

                return (
                    typeof candidate.content === "string" &&
                    ["user", "assistant", "system"].includes(candidate.role || "")
                );
            });

            if (messages.length > 0) {
                return {
                    messages,
                    mode,
                    orgId,
                    orgName: explicitOrgName ?? inferOrganizationName(messages),
                };
            }
        }
    } catch {
        if (payload.trim()) {
            return { messages: [{ role: "user", content: payload }] };
        }
    }

    throw new Error("Send a non-empty text message or JSON payload with a `message` field.");
}

function getResponseContent(content: unknown): string {
    if (typeof content === "string") {
        return content;
    }

    return JSON.stringify(content);
}

function addContextToFirstUserMessage(messages: ChatMessage[], context: string): ChatMessage[] {
    let contextAdded = false;

    return messages.map((message) => {
        if (contextAdded || message.role !== "user") {
            return message;
        }

        contextAdded = true;

        return {
            ...message,
            content: `${context}\n\n${message.content}`,
        };
    });
}

async function requestAppApi<T>(path: string, accessToken: string, options: RequestInit = {}): Promise<T> {
    const headers = new Headers(options.headers);

    headers.set("Accept", "application/json");
    headers.set("Authorization", `Bearer ${accessToken}`);

    if (options.body && !headers.has("Content-Type")) {
        headers.set("Content-Type", "application/json");
    }

    logger.info({
        method: options.method ?? "GET",
        path,
    }, "Agent direct app API request");

    const response = await fetch(`${appBaseUrl}${path}`, {
        ...options,
        headers,
        signal: AbortSignal.timeout(30000),
    });
    const contentType = response.headers.get("content-type") || "";
    const body = contentType.includes("application/json")
        ? await response.json().catch(() => ({}))
        : await response.text();

    logger.info({
        method: options.method ?? "GET",
        path,
        statusCode: response.status,
    }, "Agent direct app API response");

    if (!response.ok) {
        throw new Error(`App API request failed with ${response.status}: ${JSON.stringify(body)}`);
    }

    return body as T;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, description: string): Promise<T> {
    let timeout: ReturnType<typeof setTimeout> | undefined;

    try {
        return await Promise.race([
            promise,
            new Promise<never>((_, reject) => {
                timeout = setTimeout(() => reject(new Error(`${description} timed out after ${timeoutMs}ms`)), timeoutMs);
            }),
        ]);
    } finally {
        if (timeout) {
            clearTimeout(timeout);
        }
    }
}

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

function getBearerToken(authorization?: string | string[]) {
    const value = Array.isArray(authorization) ? authorization[0] : authorization;

    return value?.startsWith("Bearer ") ? value.slice(7) : "";
}

function getWebSocketProtocolToken(protocolHeader?: string | string[]) {
    const value = Array.isArray(protocolHeader) ? protocolHeader[0] : protocolHeader;
    const protocols = value?.split(",").map((protocol) => protocol.trim()).filter(Boolean) ?? [];
    const bearerIndex = protocols.indexOf("bearer");

    return bearerIndex >= 0 ? protocols[bearerIndex + 1] ?? "" : "";
}

function getTokenOrganizationId(token: string): string {
    const payload = decodeJwtPayload(token);

    return typeof payload?.org_id === "string" ? payload.org_id : "";
}

async function exchangeOrganizationToken({
    scopes,
    switchingOrganizationId,
    token,
}: {
    scopes: string;
    switchingOrganizationId: string;
    token: string;
}) {
    const credentials = Buffer.from(`${asgardeoConfig.clientId}:${asgardeoConfig.clientSecret}`).toString("base64");
    const response = await fetch(`${asgardeoConfig.baseUrl}/oauth2/token`, {
        body: new URLSearchParams({
            grant_type: "organization_switch",
            scope: scopes,
            switching_organization: switchingOrganizationId,
            token,
        }),
        headers: {
            Authorization: `Basic ${credentials}`,
            "Content-Type": "application/x-www-form-urlencoded",
        },
        method: "POST",
        signal: AbortSignal.timeout(30000),
    });
    const body = await response.json().catch(() => ({})) as {
        access_token?: string;
        error?: string;
        error_description?: string;
    };

    if (!response.ok || !body.access_token) {
        throw new Error(body.error_description ?? body.error ?? "Failed to exchange token for the organization.");
    }

    return body.access_token;
}

function shouldUseDelegatedUserAccess(messages: ChatMessage[]) {
    const latestMessage = messages[messages.length - 1]?.content.toLowerCase() || "";
    const delegatedIntentPattern = /\b(update|change|set|invite|add|create|delete|remove|assign|reset|lock|unlock|disable|enable|upgrade|book|booking|reserve|reservation|confirm)\b/;

    return delegatedIntentPattern.test(latestMessage) || Boolean(inferOrganizationName(messages) && hasBookingIntent(messages));
}

function resolveInvocationMode(request: ParsedChatRequest): ChatInvocationMode {
    return request.mode ?? (shouldUseDelegatedUserAccess(request.messages) ? "user" : "agent");
}

function isBookingIntent(messages: ChatMessage[]) {
    const latestMessage = messages[messages.length - 1]?.content.toLowerCase() || "";

    return /\b(book|booking|reserve|reservation)\b/.test(latestMessage);
}

function hasBookingIntent(messages: ChatMessage[]) {
    return messages.some((message) => (
        message.role === "user" &&
        /\b(book|booking|reserve|reservation)\b/i.test(message.content)
    ));
}

function shouldPrefetchTravelPolicy(messages: ChatMessage[]) {
    return messages.some((message) => (
        message.role === "user" &&
        /\b(book|booking|reserve|reservation|travel\s+policy|policy)\b/i.test(message.content)
    ));
}

function isTravelPolicyIntent(messages: ChatMessage[]) {
    const latestMessage = messages[messages.length - 1]?.content.toLowerCase() || "";

    return /\b(travel\s+policy|policy|eligible flights?|compliant flights?|available flights?|flights? available|show flights?|list flights?|find flights?)\b/.test(latestMessage);
}

function getUserMessageText(messages: ChatMessage[]) {
    return messages
        .filter((message) => message.role === "user")
        .map((message) => message.content)
        .join("\n");
}

function cleanCriteriaValue(value: string) {
    return value
        .replace(/\b(on|for|departing|leaving|date|please|thanks|thank you)\b.*$/i, "")
        .replace(/[.?!,;:]+$/g, "")
        .trim();
}

function extractBookingSearchCriteria(messages: ChatMessage[]): BookingSearchCriteria {
    const text = getUserMessageText(messages);
    const criteria: BookingSearchCriteria = {};
    const routeMatch = text.match(/\bfrom\s+(.+?)\s+to\s+(.+?)(?:\s+(?:on|for|departing|leaving|date)\b|[.?!,;]|\n|$)/i);

    if (routeMatch?.[1]) {
        criteria.from = cleanCriteriaValue(routeMatch[1]);
    }

    if (routeMatch?.[2]) {
        criteria.to = cleanCriteriaValue(routeMatch[2]);
    }

    const dateMatch = text.match(/\b(?:on|for|departing|leaving|date(?: is)?|departure date(?: is)?)\s+([a-z]{3,9}\s+\d{1,2}(?:,\s*\d{4})?|\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}(?:\/\d{2,4})?|tomorrow|today)\b/i)
        ?? text.match(/\b((?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+\d{1,2}(?:,\s*\d{4})?)\b/i);

    if (dateMatch?.[1]) {
        criteria.departureDate = dateMatch[1].trim();
    }

    return criteria;
}


function normalizeDateText(value: string) {
    return value
        .toLowerCase()
        .replace(/\bjanuary\b/g, "jan")
        .replace(/\bfebruary\b/g, "feb")
        .replace(/\bmarch\b/g, "mar")
        .replace(/\bapril\b/g, "apr")
        .replace(/\bjune\b/g, "jun")
        .replace(/\bjuly\b/g, "jul")
        .replace(/\baugust\b/g, "aug")
        .replace(/\bseptember\b/g, "sep")
        .replace(/\boctober\b/g, "oct")
        .replace(/\bnovember\b/g, "nov")
        .replace(/\bdecember\b/g, "dec")
        .replace(/[,]/g, "")
        .replace(/\s+/g, " ")
        .trim();
}

function flightMatchesDepartureDate(flight: Flight, departureDate?: string) {
    if (!departureDate || /\b(today|tomorrow)\b/i.test(departureDate)) {
        return true;
    }

    return normalizeDateText(flight.dates).includes(normalizeDateText(departureDate));
}

const CABIN_RANK: Record<string, number> = {
    "Economy": 0,
    "Premium Economy": 1,
    "Business": 2,
    "First Class": 3,
};

function evaluateFlightPolicy(flight: Flight, policy: TravelPolicy | null): { notes: string[]; status: PolicyStatus } {
    if (!policy) {
        return { notes: [], status: "in-policy" };
    }

    const notes: string[] = [];
    const priceCap = policy.max_flight_price;
    const approvalCap = priceCap * (1 + policy.price_cap_percent / 100);
    const allowedCabinRank = CABIN_RANK[policy.domestic_cabin] ?? 0;
    const flightCabinRank = CABIN_RANK[flight.cabin] ?? 0;
    const priceOver = flight.price > priceCap;
    const priceWayOver = flight.price > approvalCap;
    const cabinOver = flightCabinRank > allowedCabinRank;
    const cabinWayOver = flightCabinRank > allowedCabinRank + 1;

    if (priceWayOver) notes.push(`price exceeds $${approvalCap.toFixed(0)} approval limit`);
    else if (priceOver) notes.push(`price exceeds $${priceCap} cap`);

    if (cabinWayOver) notes.push(`${flight.cabin} is not allowed by ${policy.domestic_cabin} policy`);
    else if (cabinOver) notes.push(`${flight.cabin} is above ${policy.domestic_cabin}`);

    if (priceWayOver || cabinWayOver) return { notes, status: "out-of-policy" };
    if (priceOver || cabinOver) return { notes, status: "approval-required" };

    return { notes: [], status: "in-policy" };
}

function formatTravelPolicyAndFlights(policy: TravelPolicy | null, flights: SuggestedFlight[]) {
    const eligibleFlights = flights.filter((flight) => flight.policyStatus !== "out-of-policy").slice(0, 5);

    const policyLine = policy
        ? `Your organization's travel policy covers **${policy.domestic_cabin}** class up to **$${policy.max_flight_price}**/ticket (flights up to ${policy.price_cap_percent}% above the cap require manager approval).`
        : "Your organization has no active travel policy configured, so all available flights are eligible.";

    if (eligibleFlights.length === 0) {
        return `${policyLine}\n\nUnfortunately, I wasn't able to find any eligible flights at the moment. Would you like to try a different route or date?`;
    }

    const policyBadge = (status: PolicyStatus) =>
        status === "in-policy" ? "✓ In policy" : "⚠ Needs approval";

    const rows = eligibleFlights.map((flight, index) =>
        `| ${index + 1} | ${flight.airline} | ${flight.from_city} → ${flight.to_city} | ${flight.departure_time} | ${flight.cabin} | $${flight.price} | ${flight.duration} | ${policyBadge(flight.policyStatus)} |`
    );

    return [
        policyLine,
        "",
        "Here are the available flights for your trip:",
        "",
        "| # | Airline | Route | Departure | Class | Price | Duration | Policy |",
        "|---|---------|-------|-----------|-------|-------|----------|--------|",
        ...rows,
        "",
        "Which flight would you like to book? Just reply with the number or flight ID.",
    ].join("\n");
}

function formatEligibleFlightList(flights: SuggestedFlight[]) {
    const eligibleFlights = flights.filter((flight) => flight.policyStatus !== "out-of-policy").slice(0, 5);

    if (eligibleFlights.length === 0) {
        return "I wasn't able to find any available flights matching your criteria right now. You can try a different route, or reach out to your travel administrator for assistance.";
    }

    const policyBadge = (status: PolicyStatus) =>
        status === "in-policy" ? "✓ In policy" : "⚠ Needs approval";

    const rows = eligibleFlights.map((flight, index) =>
        `| ${index + 1} | ${flight.airline} | ${flight.from_city} → ${flight.to_city} | ${flight.departure_time} | ${flight.cabin} | $${flight.price} | ${flight.duration} | ${policyBadge(flight.policyStatus)} |`
    );

    return [
        "Here are the available flights for your trip:",
        "",
        "| # | Airline | Route | Departure | Class | Price | Duration | Policy |",
        "|---|---------|-------|-----------|-------|-------|----------|--------|",
        ...rows,
        "",
        "Which one would you like to book? Just reply with the number or flight ID.",
    ].join("\n");
}

function resolveRequestedFlightId(messages: ChatMessage[], suggestedFlights: SuggestedFlight[]) {
    const latestMessage = messages[messages.length - 1]?.content || "";
    const explicitId = latestMessage.match(/\bflight-[a-z0-9-]+\b/i)?.[0];

    if (explicitId) {
        if (suggestedFlights.length === 0 || suggestedFlights.some((flight) => flight.id === explicitId)) {
            return explicitId;
        }

        return undefined;
    }

    const ordinalMatch = latestMessage.match(/\b(?:option|flight|number)?\s*(\d{1,2})(?:st|nd|rd|th)?\b/i);
    const ordinal = ordinalMatch ? Number(ordinalMatch[1]) : NaN;

    if (Number.isInteger(ordinal) && ordinal >= 1 && ordinal <= suggestedFlights.length) {
        return suggestedFlights[ordinal - 1]?.id;
    }

    if (/\b(first|cheapest|lowest)\b/i.test(latestMessage)) {
        return suggestedFlights[0]?.id;
    }

    return undefined;
}

function inferOrganizationName(messages: ChatMessage[]) {
    const latestMessage = messages[messages.length - 1]?.content.trim() || "";
    const explicitMatch = latestMessage.match(/\b(?:org(?:anization)?|company|tenant)\s*(?:name\s*)?(?:is|=|:)\s*([^,.]+)$/i);

    if (explicitMatch?.[1]) {
        return explicitMatch[1].trim();
    }

    const previousMessage = messages[messages.length - 2]?.content.toLowerCase() || "";
    const latestLooksLikeName = /^[a-z0-9][a-z0-9 _-]{1,64}$/i.test(latestMessage);

    if (latestLooksLikeName && previousMessage.includes("organization")) {
        return latestMessage;
    }

    return undefined;
}

const pendingDelegations = new Map<string, PendingDelegation>();

function buildOboAuthorizeUrl(state: string, request: ParsedChatRequest) {
    const params = new URLSearchParams({
        client_id: asgardeoConfig.clientId,
        redirect_uri: oboRedirectUri,
        requested_actor: agentConfig.agentID,
        response_type: "code",
        scope: delegatedBookingScopes,
        state,
    });

    if (oboResource) {
        params.set("resource", oboResource);
    }

    if (request.orgName) {
        params.set("org", request.orgName);
    }

    if (request.orgId) {
        params.set("orgId", request.orgId);
    }

    params.set("fidp", "OrganizationSSO");

    return `${asgardeoConfig.baseUrl}/oauth2/authorize?${params.toString()}`;
}

async function exchangeOboAuthorizationCode(code: string, agentActorToken: string) {
    logger.info("Exchanging OBO authorization code for delegated access token");

    const response = await fetch(`${asgardeoConfig.baseUrl}/oauth2/token`, {
        body: new URLSearchParams({
            actor_token: agentActorToken,
            client_id: asgardeoConfig.clientId,
            client_secret: asgardeoConfig.clientSecret,
            code,
            grant_type: "authorization_code",
            redirect_uri: oboRedirectUri,
            tokenBindingId: randomUUID(),
        }),
        headers: {
            "Content-Type": "application/x-www-form-urlencoded",
        },
        method: "POST",
        signal: AbortSignal.timeout(30000),
    });

    logger.info({ statusCode: response.status }, "OBO token exchange response received");

    const body = await response.json().catch(() => ({})) as {
        access_token?: string;
        error?: string;
        error_description?: string;
    };

    if (!response.ok || !body.access_token) {
        throw new Error(body.error_description ?? body.error ?? "Failed to exchange the OBO authorization code.");
    }

    return body.access_token;
}

function createWebSocketAcceptKey(key: string): string {
    return createHash("sha1")
        .update(`${key}${WEB_SOCKET_GUID}`)
        .digest("base64");
}

function encodeWebSocketFrame(payload: string, opcode = 0x1): Buffer {
    const payloadBuffer = Buffer.from(payload);
    const payloadLength = payloadBuffer.length;

    if (payloadLength <= 125) {
        return Buffer.concat([
            Buffer.from([0x80 | opcode, payloadLength]),
            payloadBuffer,
        ]);
    }

    if (payloadLength <= 65535) {
        const header = Buffer.alloc(4);
        header[0] = 0x80 | opcode;
        header[1] = 126;
        header.writeUInt16BE(payloadLength, 2);

        return Buffer.concat([header, payloadBuffer]);
    }

    const header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(payloadLength), 2);

    return Buffer.concat([header, payloadBuffer]);
}

function parseWebSocketFrame(
    buffer: Buffer<ArrayBufferLike>
): { frame: WebSocketFrame; remaining: Buffer<ArrayBufferLike> } | null {
    if (buffer.length < 2) {
        return null;
    }

    const opcode = buffer[0] & 0x0f;
    const isMasked = (buffer[1] & 0x80) === 0x80;
    let payloadLength = buffer[1] & 0x7f;
    let offset = 2;

    if (payloadLength === 126) {
        if (buffer.length < offset + 2) {
            return null;
        }

        payloadLength = buffer.readUInt16BE(offset);
        offset += 2;
    } else if (payloadLength === 127) {
        if (buffer.length < offset + 8) {
            return null;
        }

        const extendedPayloadLength = buffer.readBigUInt64BE(offset);

        if (extendedPayloadLength > BigInt(Number.MAX_SAFE_INTEGER)) {
            throw new Error("WebSocket message is too large.");
        }

        payloadLength = Number(extendedPayloadLength);
        offset += 8;
    }

    const maskOffset = offset;

    if (isMasked) {
        offset += 4;
    }

    if (buffer.length < offset + payloadLength) {
        return null;
    }

    const payload = Buffer.from(buffer.subarray(offset, offset + payloadLength));

    if (isMasked) {
        const mask = buffer.subarray(maskOffset, maskOffset + 4);

        for (let index = 0; index < payload.length; index += 1) {
            payload[index] = payload[index] ^ mask[index % 4];
        }
    }

    return {
        frame: { opcode, payload },
        remaining: buffer.subarray(offset + payloadLength),
    };
}

function isSocketWritable(socket: Duplex) {
    return !socket.destroyed && !socket.writableEnded;
}

function writeFrame(socket: Duplex, frame: Buffer) {
    if (!isSocketWritable(socket)) {
        return false;
    }

    try {
        socket.write(frame);

        return true;
    } catch (error) {
        logger.warn({ err: error }, "Unable to write WebSocket frame");

        return false;
    }
}

function sendJson(socket: Duplex, payload: Record<string, unknown>) {
    return writeFrame(socket, encodeWebSocketFrame(JSON.stringify(payload)));
}

function closeWebSocket(socket: Duplex) {
    if (isSocketWritable(socket)) {
        try {
            socket.end(encodeWebSocketFrame("", 0x8));
        } catch {
            socket.destroy();
        }
    }
}

function redactSecret(value: string) {
    if (!value) {
        return "";
    }

    if (value.length <= 6) {
        return "***";
    }

    return `${value.slice(0, 3)}***${value.slice(-3)}`;
}

function includeClientSecretInAgentAuthorizeRequest(client: AsgardeoJavaScriptClient) {
    if (getEnv("INCLUDE_CLIENT_SECRET_IN_AUTHORIZE") === "false") {
        logger.warn("Skipping client_secret injection for the agent authorize request");

        return;
    }

    if (!asgardeoConfig.clientSecret) {
        return;
    }

    const sdkClient = client as unknown as {
        auth?: {
            getSignInUrl?: (requestConfig?: Record<string, unknown>, userId?: string) => Promise<string>;
        };
    };
    const getSignInUrl = sdkClient.auth?.getSignInUrl?.bind(sdkClient.auth);

    if (!getSignInUrl || !sdkClient.auth) {
        return;
    }

    sdkClient.auth.getSignInUrl = async (requestConfig = {}, userId?: string) => {
        const signInUrl = await getSignInUrl({
            ...requestConfig,
            client_secret: requestConfig.client_secret ?? "__include_client_secret__",
        }, userId);

        return signInUrl;
    };
}

function validateAgentConfiguration() {
    const requiredValues: Record<string, string | undefined> = {
        ASGARDEO_BASE_URL: asgardeoConfig.baseUrl,
        CLIENT_ID: asgardeoConfig.clientId,
        CLIENT_SECRET: asgardeoConfig.clientSecret,
        REDIRECT_URI: asgardeoConfig.afterSignInUrl,
        AGENT_ID: agentConfig.agentID,
        AGENT_SECRET: agentConfig.agentSecret,
        ANTHROPIC_FEDERATION_RULE_ID: wifConfig.federationRuleId,
        ANTHROPIC_ORGANIZATION_ID: wifConfig.organizationId,
        ANTHROPIC_SERVICE_ACCOUNT_ID: wifConfig.serviceAccountId,
        ANTHROPIC_WORKSPACE_ID: wifConfig.workspaceId,
        "ANTHROPIC_IDENTITY_TOKEN or ANTHROPIC_IDENTITY_TOKEN_FILE": wifConfig.identityToken || wifConfig.identityTokenFile,
    };
    const missingValues = Object.entries(requiredValues)
        .filter(([, value]) => !value)
        .map(([name]) => name);

    if (missingValues.length > 0) {
        throw new Error(`Missing required AI agent environment values: ${missingValues.join(", ")}`);
    }

    if (asgardeoConfig.baseUrl.includes("<") || asgardeoConfig.baseUrl.includes(">")) {
        throw new Error("ASGARDEO_BASE_URL still contains a placeholder value.");
    }

    try {
        new URL(asgardeoConfig.afterSignInUrl);
    } catch {
        throw new Error("REDIRECT_URI must be an absolute URL, for example http://localhost:8791.");
    }
}

function writeHttpJson(response: ServerResponse, statusCode: number, body: Record<string, unknown>) {
    response.writeHead(statusCode, { "Content-Type": "application/json" });
    response.end(JSON.stringify(body));
}

function writeHttpHtml(response: ServerResponse, statusCode: number, body: string) {
    response.writeHead(statusCode, { "Content-Type": "text/html; charset=utf-8" });
    response.end(body);
}

async function createMcpAgent(authorization: string, mode: ChatInvocationMode): Promise<AgentRuntime> {
    const model = await createModel();
    const client = new MultiServerMCPClient({
        travel: {
            transport: "http",
            url: process.env.MCP_SERVER_URL || "http://localhost:8001/mcp",
            headers: {
                Authorization: authorization,
            },
        },
    });

    const tools = await client.getTools();
    logger.info({
        mode,
        tools: tools.map((tool) => tool.name).filter(Boolean),
    }, "Loaded MCP tools");

    const agent = createReactAgent({
        llm: model,
        tools: tools,
        prompt: agentPrompt,
    }) as RunnableAgent;

    return { agent, client, tools };
}

async function getAutonomousAgentOrganizationToken(rootAgentToken: string, organizationId: string) {
    logger.info({
        organizationId,
        tokenType: "autonomous-agent",
        scopes: autonomousTravelPolicyScopes,
    }, `[org: ${organizationId}] Obtaining autonomous agent organization-scoped token`);

    const token = await exchangeOrganizationToken({
        scopes: autonomousTravelPolicyScopes,
        switchingOrganizationId: organizationId,
        token: rootAgentToken,
    });

    logger.info({ organizationId, tokenType: "autonomous-agent" }, `[org: ${organizationId}] Autonomous agent organization-scoped token obtained`);

    return token;
}

async function getDelegatedUserOrganizationToken(accessToken: string, orgId?: string, scopes = delegatedUserOrganizationScopes) {
    if (!orgId) {
        return accessToken;
    }

    if (getTokenOrganizationId(accessToken) === orgId) {
        logger.info({ organizationId: orgId }, `[org: ${orgId}] Delegated token already scoped to organization, skipping exchange`);

        return accessToken;
    }

    logger.info({
        organizationId: orgId,
        tokenType: "delegated-user",
        scopes,
    }, `[org: ${orgId}] Obtaining delegated user organization-scoped token`);

    const token = await exchangeOrganizationToken({
        scopes,
        switchingOrganizationId: orgId,
        token: accessToken,
    });

    logger.info({ organizationId: orgId, tokenType: "delegated-user" }, `[org: ${orgId}] Delegated user organization-scoped token obtained`);

    return token;
}

async function createRootAgentRuntime(): Promise<RootAgentRuntime> {
    logger.info("Starting Wayfinder Enterprise AI agent with Asgardeo, LangChain, and Claude WIF");
    validateAgentConfiguration();
    logger.info({
        baseUrl: asgardeoConfig.baseUrl,
        clientId: redactSecret(asgardeoConfig.clientId),
        redirectUri: asgardeoConfig.afterSignInUrl,
        agentId: redactSecret(agentConfig.agentID),
    }, "Requesting Asgardeo agent token");

    const asgardeoJavaScriptClient = new AsgardeoJavaScriptClient(asgardeoConfig);
    includeClientSecretInAgentAuthorizeRequest(asgardeoJavaScriptClient);
    const agentToken = await asgardeoJavaScriptClient.getAgentToken(agentConfig);

    await getWifToken();
    logger.info("Claude WIF credentials verified");

    return {
        agentActorToken: agentToken.accessToken,
    };
}

async function createAutonomousAgentRuntime(rootRuntime: RootAgentRuntime, organizationId: string) {
    const organizationAccessToken = await getAutonomousAgentOrganizationToken(rootRuntime.agentActorToken, organizationId);

    return createMcpAgent(`Bearer ${organizationAccessToken}`, "agent");
}

async function getTravelPolicyAndEligibleFlights(
    rootRuntime: RootAgentRuntime,
    organizationId: string,
    criteria: BookingSearchCriteria = {}
) {
    const organizationAccessToken = await getAutonomousAgentOrganizationToken(rootRuntime.agentActorToken, organizationId);
    const params = new URLSearchParams();

    if (criteria.from) params.set("from", criteria.from);
    if (criteria.to) params.set("to", criteria.to);

    const flightsPath = `/api/flights${params.size > 0 ? `?${params.toString()}` : ""}`;
    const [{ policy }, { flights }, bookingsResult] = await Promise.all([
        requestAppApi<{ policy: TravelPolicy | null }>("/api/travel-policies", organizationAccessToken),
        requestAppApi<{ flights: Flight[] }>(flightsPath, organizationAccessToken),
        requestAppApi<{ bookings: Array<{ flight_id: string; status: string }> }>("/api/bookings?all=true", organizationAccessToken)
            .catch(() => ({ bookings: [] })),
    ]);
    const bookedFlightIds = new Set(
        bookingsResult.bookings
            .filter((b) => b.status === "confirmed")
            .map((b) => b.flight_id)
    );
    const evaluatedFlights = flights
        .filter((flight) => !bookedFlightIds.has(flight.id))
        .filter((flight) => flightMatchesDepartureDate(flight, criteria.departureDate))
        .map((flight) => {
            const result = evaluateFlightPolicy(flight, policy);

            return {
                ...flight,
                policyNotes: result.notes,
                policyStatus: result.status,
            };
        })
        .sort((left, right) => {
            const statusRank: Record<PolicyStatus, number> = {
                "in-policy": 0,
                "approval-required": 1,
                "out-of-policy": 2,
            };

            return statusRank[left.policyStatus] - statusRank[right.policyStatus] || left.price - right.price;
        });

    return {
        flights: evaluatedFlights,
        message: formatTravelPolicyAndFlights(policy, evaluatedFlights),
        policy,
    };
}

async function prefetchTravelPolicy(runtime: AgentRuntime): Promise<string | null> {
    const tool = runtime.tools.find((candidate) => isToolNamed(candidate, "get_travel_policy"));

    if (!tool?.invoke) {
        logger.warn("get_travel_policy tool is not available for deterministic prefetch");

        return null;
    }

    logger.info("Prefetching travel policy before delegated agent invocation");
    const result = await tool.invoke({});
    logger.info("Travel policy prefetch completed");

    return getResponseContent(result);
}

async function invokeWithDelegatedUserAccess(request: ParsedChatRequest, delegatedAccessToken: string) {
    logger.info({
        hasOrgId: Boolean(request.orgId),
        messageCount: request.messages.length,
    }, "Starting delegated user agent invocation");

    const accessToken = await getDelegatedUserOrganizationToken(delegatedAccessToken, request.orgId);
    logger.info("Delegated organization access token is ready");

    const runtime = await createMcpAgent(`Bearer ${accessToken}`, "user");
    logger.info("Delegated MCP agent runtime is ready");

    try {
        let messages = request.messages;

        if (shouldPrefetchTravelPolicy(request.messages)) {
            const travelPolicy = await prefetchTravelPolicy(runtime);

            if (travelPolicy) {
                messages = addContextToFirstUserMessage(
                    request.messages,
                    `The active organization travel policy was already retrieved for this turn. Use this policy context before evaluating or booking flights:\n${travelPolicy}`
                );
            }
        }

        logger.info("Invoking delegated MCP agent");
        const result = await withTimeout(
            runtime.agent.invoke({ messages }),
            60000,
            "Delegated MCP agent invocation"
        );
        logger.info("Delegated MCP agent invocation completed");

        return getResponseContent(result.messages.at(-1)?.content);
    } finally {
        await runtime.client.close();
        logger.info("Delegated MCP client closed");
    }
}

async function createBookingWithDelegatedUserAccess(pending: PendingDelegation, delegatedAccessToken: string) {
    if (!pending.flightId) {
        throw new Error("No flight was selected for booking.");
    }

    const accessToken = await getDelegatedUserOrganizationToken(
        delegatedAccessToken,
        pending.orgId,
        delegatedBookingScopes
    );
    const bookingResponse = await requestAppApi<{ booking?: { booking_reference?: string } }>("/api/bookings", accessToken, {
        body: JSON.stringify({
            bookedByName: "AI-assisted user",
            flightId: pending.flightId,
            travelers: 1,
        }),
        method: "POST",
    });
    const reference = bookingResponse.booking?.booking_reference;

    return reference
        ? `Booked flight ${pending.flightId}. Booking reference: ${reference}.`
        : `Booked flight ${pending.flightId}.`;
}

function registerPendingDelegation(socket: Duplex, request: ParsedChatRequest, flightId?: string) {
    const state = randomUUID();

    pendingDelegations.set(state, {
        createdAt: Date.now(),
        flightId,
        orgId: request.orgId,
        request,
        socket,
    });

    return {
        authorizationUrl: buildOboAuthorizeUrl(state, request),
        state,
    };
}

function removeExpiredPendingDelegations() {
    const expiresBefore = Date.now() - 10 * 60 * 1000;

    for (const [state, pending] of pendingDelegations) {
        if (pending.createdAt < expiresBefore) {
            pendingDelegations.delete(state);
        }
    }
}

async function handleOboCallback(url: URL, response: ServerResponse, agentActorToken?: string) {
    removeExpiredPendingDelegations();

    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    const error = url.searchParams.get("error");
    const errorDescription = url.searchParams.get("error_description");

    if (error) {
        writeHttpHtml(response, 400, `<p>Authorization failed: ${errorDescription || error}</p>`);
        return;
    }

    if (!code || !state) {
        writeHttpHtml(response, 400, "<p>Missing authorization code or state.</p>");
        return;
    }

    if (!agentActorToken) {
        writeHttpHtml(response, 500, "<p>The agent actor token is not available.</p>");
        return;
    }

    const pending = pendingDelegations.get(state);

    if (!pending) {
        writeHttpHtml(response, 410, "<p>This authorization request has expired. Please retry the action from the chat.</p>");
        return;
    }

    pendingDelegations.delete(state);
    writeHttpHtml(response, 200, "<p>Authorization complete. You can close this tab and return to Wayfinder.</p>");

    try {
        logger.info({
            hasPendingSocket: isSocketWritable(pending.socket),
            messageCount: pending.request.messages.length,
        }, "Completing delegated authorization callback");

        const delegatedAccessToken = await exchangeOboAuthorizationCode(code, agentActorToken);
        logger.info("Delegated access token received from OBO callback");

        const responseMessage = pending.flightId
            ? await createBookingWithDelegatedUserAccess(pending, delegatedAccessToken)
            : await invokeWithDelegatedUserAccess(pending.request, delegatedAccessToken);
        logger.info({
            responseLength: responseMessage.length,
            socketWritable: isSocketWritable(pending.socket),
        }, "Sending delegated agent response over WebSocket");

        const sent = sendJson(pending.socket, {
            type: "response",
            message: responseMessage,
        });
        logger.info({ sent }, "Delegated agent WebSocket response send completed");
    } catch (callbackError) {
        logger.error({ err: callbackError }, "Failed to complete delegated authorization callback");
        sendJson(pending.socket, {
            type: "error",
            message: "I couldn't complete the authorization. Please try approving the action again.",
        });
    }
}

async function runAgentServer() {
    const rootRuntime = await createRootAgentRuntime();
    const autonomousRuntimePromises = new Map<string, Promise<AgentRuntime>>();
    const port = Number(process.env.PORT || process.env.AGENT_PORT || 8791);
    const host = process.env.HOST || "localhost";

    const getAutonomousRuntime = (organizationId: string) => {
        if (!autonomousRuntimePromises.has(organizationId)) {
            autonomousRuntimePromises.set(organizationId, createAutonomousAgentRuntime(rootRuntime, organizationId));
        }

        return autonomousRuntimePromises.get(organizationId)!;
    };

    const server = createServer(async (request, response) => {
        const requestId = randomUUID();
        const startedAt = performance.now();
        const requestLogger = logger.child({
            requestId,
            method: request.method,
            path: request.url,
        });

        response.setHeader("X-Request-Id", requestId);
        response.on("finish", () => {
            requestLogger.info({
                statusCode: response.statusCode,
                durationMs: Number((performance.now() - startedAt).toFixed(1)),
            }, "HTTP request completed");
        });
        requestLogger.info("HTTP request started");

        const url = new URL(request.url || "/", `http://${request.headers.host || host}`);

        if (url.pathname === "/obo/callback") {
            await handleOboCallback(url, response, rootRuntime.agentActorToken);

            return;
        }

        if (url.pathname === "/health") {
            writeHttpJson(response, 200, {
                status: "ok",
                features: {
                    enterpriseTravelTools: true,
                    autonomousOrganizationToken: autonomousRuntimePromises.size > 0 ? "initialized" : "lazy",
                },
            });

            return;
        }

        writeHttpJson(response, 404, { error: "Not found" });
    });

    const handleConnection = (socket: Duplex, authenticatedOrgId: string) => {
        const connectionId = randomUUID();
        const connectionLogger = logger.child({ connectionId });
        let isClosed = false;
        let lastSuggestedFlights: SuggestedFlight[] = [];

        connectionLogger.info("WebSocket client connected");

        socket.on("close", () => {
            isClosed = true;
            connectionLogger.info("WebSocket client closed connection");
        });

        socket.on("end", () => {
            isClosed = true;
        });

        socket.on("error", (error) => {
            isClosed = true;
            connectionLogger.warn({ err: error }, "WebSocket client disconnected");
        });

        sendJson(socket, {
            type: "ready",
            message: "Connected to the Wayfinder Enterprise AI agent.",
        });

        let queue = Promise.resolve();
        let buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);

        socket.on("data", (data) => {
            buffer = Buffer.concat([buffer, data]);

            try {
                let parsed = parseWebSocketFrame(buffer);

                while (parsed) {
                    buffer = parsed.remaining;

                    if (parsed.frame.opcode === 0x8) {
                        closeWebSocket(socket);

                        return;
                    }

                    if (parsed.frame.opcode === 0x9) {
                        writeFrame(socket, encodeWebSocketFrame(parsed.frame.payload.toString(), 0xA));
                    }

                    if (parsed.frame.opcode === 0x1) {
                        const payload = parsed.frame.payload.toString("utf8");

                        queue = queue.then(async () => {
                            if (isClosed) {
                                return;
                            }

                            const parsedChatRequest = parseChatRequest(payload);
                            const chatRequest: ParsedChatRequest = {
                                ...parsedChatRequest,
                                orgId: authenticatedOrgId,
                            };
                            const llmMessages = addContextToFirstUserMessage(
                                chatRequest.messages,
                                `Authenticated organization ID for this chat: ${authenticatedOrgId}`
                            );
                            const mode = resolveInvocationMode(chatRequest);
                            const latestMessage = chatRequest.messages[chatRequest.messages.length - 1]?.content || "";
                            const messageLogger = connectionLogger.child({
                                mode,
                                messageCount: chatRequest.messages.length,
                                latestMessageLength: latestMessage.length,
                            });

                            if (!sendJson(socket, { type: "processing" })) {
                                isClosed = true;
                                return;
                            }

                            messageLogger.info("Processing chat message");
                            const responseMessage = mode === "user"
                                ? await (async () => {
                                    if (isBookingIntent(chatRequest.messages)) {
                                        const flightId = resolveRequestedFlightId(chatRequest.messages, lastSuggestedFlights);

                                        if (!flightId) {
                                            const criteria = extractBookingSearchCriteria(chatRequest.messages);
                                            const result = await getTravelPolicyAndEligibleFlights(rootRuntime, authenticatedOrgId, criteria);
                                            lastSuggestedFlights = result.flights.filter((flight) => flight.policyStatus !== "out-of-policy");

                                            sendJson(socket, {
                                                type: "response",
                                                message: formatEligibleFlightList(result.flights),
                                            });

                                            return "";
                                        }

                                        const delegation = registerPendingDelegation(socket, chatRequest, flightId);

                                        sendJson(socket, {
                                            type: "authorization_required",
                                            authorizationUrl: delegation.authorizationUrl,
                                            message: `Great choice! To complete your booking, I'll need your authorization. Please click the link below to approve and finalize the reservation for **${flightId}**.`,
                                        });

                                        return "";
                                    }

                                    sendJson(socket, {
                                        type: "response",
                                        message: "I'm here to help with your business travel! I can look up your organization's travel policy, find available flights, and book a flight for you after a quick authorization step. What would you like to do?",
                                    });

                                    return "";
                                })()
                                : await (async () => {
                                    if (isTravelPolicyIntent(chatRequest.messages)) {
                                        const result = await getTravelPolicyAndEligibleFlights(rootRuntime, authenticatedOrgId);

                                        lastSuggestedFlights = result.flights.filter((flight) => flight.policyStatus !== "out-of-policy");

                                        return result.message;
                                    }

                                    const autonomousRuntime = await getAutonomousRuntime(authenticatedOrgId);

                                    return getResponseContent(
                                        (await autonomousRuntime.agent.invoke({ messages: llmMessages })).messages.at(-1)?.content
                                    );
                                })();

                            if (mode === "user") {
                                return;
                            }

                            if (isClosed) {
                                return;
                            }

                            sendJson(socket, {
                                type: "response",
                                message: responseMessage,
                            });
                            messageLogger.info({ responseLength: responseMessage.length }, "Chat message processed");
                        }).catch((error: unknown) => {
                            if (isClosed) {
                                return;
                            }

                            connectionLogger.error({ err: error }, "Error handling chat message");
                            sendJson(socket, {
                                type: "error",
                                message: error instanceof Error ? error.message : "Failed to process chat message.",
                            });
                        });
                    }

                    parsed = parseWebSocketFrame(buffer);
                }
            } catch (error) {
                connectionLogger.error({ err: error }, "Error parsing WebSocket frame");
                sendJson(socket, {
                    type: "error",
                    message: error instanceof Error ? error.message : "Invalid WebSocket message.",
                });
                closeWebSocket(socket);
            }
        });
    };

    server.on("upgrade", (request, socket, head) => {
        socket.on("error", (error) => {
            logger.warn({ err: error }, "WebSocket upgrade socket error");
        });

        try {
            const url = new URL(request.url || "", `http://${request.headers.host || host}`);
            const key = request.headers["sec-websocket-key"];

            if (url.pathname !== "/chat" || typeof key !== "string") {
                if (!socket.destroyed && !socket.writableEnded) {
                    socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
                }
                socket.destroy();

                return;
            }

            const callerToken = getBearerToken(request.headers.authorization)
                || getWebSocketProtocolToken(request.headers["sec-websocket-protocol"]);
            const authenticatedOrgId = getTokenOrganizationId(callerToken);

            if (!callerToken || !authenticatedOrgId) {
                if (!socket.destroyed && !socket.writableEnded) {
                    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
                }
                socket.destroy();

                return;
            }

            writeFrame(socket, Buffer.from([
                "HTTP/1.1 101 Switching Protocols",
                "Upgrade: websocket",
                "Connection: Upgrade",
                `Sec-WebSocket-Accept: ${createWebSocketAcceptKey(key)}`,
                "Sec-WebSocket-Protocol: bearer",
                "",
                "",
            ].join("\r\n")));

            if (head.length > 0) {
                socket.unshift(head);
            }

            handleConnection(socket, authenticatedOrgId);
        } catch (error) {
            logger.error({ err: error }, "Error upgrading WebSocket connection");
            socket.destroy();
        }
    });

    server.listen(port, host, () => {
        logger.info({
            chatUrl: `ws://${host}:${port}/chat`,
            healthUrl: `http://${host}:${port}/health`,
        }, "AI agent WebSocket server started");
    });

    const shutdown = async () => {
        logger.info("Shutting down AI agent");
        server.close();
        for (const autonomousRuntimePromise of autonomousRuntimePromises.values()) {
            const autonomousRuntime = await autonomousRuntimePromise;
            await autonomousRuntime.client.close();
        }
        process.exit(0);
    };

    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
}

runAgentServer().catch((error: unknown) => {
    logger.fatal({ err: error }, "AI agent failed to start");
    process.exit(1);
});
