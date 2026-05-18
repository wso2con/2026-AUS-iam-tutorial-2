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

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadEnvFile(filePath: string) {
    if (!existsSync(filePath)) {
        return;
    }

    const lines = readFileSync(filePath, "utf8").split(/\r?\n/);

    for (const line of lines) {
        const trimmedLine = line.trim();

        if (!trimmedLine || trimmedLine.startsWith("#")) {
            continue;
        }

        const separatorIndex = trimmedLine.indexOf("=");

        if (separatorIndex <= 0) {
            continue;
        }

        const key = trimmedLine.slice(0, separatorIndex).trim();
        const rawValue = trimmedLine.slice(separatorIndex + 1).trim();
        const value = rawValue.replace(/^\s*["']|["']\s*$/g, "");

        if (key && process.env[key] === undefined) {
            process.env[key] = value;
        }
    }
}

loadEnvFile(resolve(__dirname, ".env"));

const appBaseUrl = (process.env.APP_BASE_URL || "http://localhost:3000").replace(/\/$/, "");
const port = Number(process.env.PORT || process.env.MCP_PORT || 8001);
const host = process.env.HOST || "localhost";

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

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

function getBearerToken(authorization?: string) {
    return authorization?.startsWith("Bearer ") ? authorization.slice(7) : "";
}

function getAuthorizationHeader(request: IncomingMessage): string | undefined {
    const authorization = request.headers.authorization;

    return Array.isArray(authorization) ? authorization[0] : authorization;
}

function createApiClient(authorization?: string) {
    async function requestApi(path: string, options: RequestInit = {}): Promise<JsonValue> {
        const headers = new Headers(options.headers);
        const method = options.method ?? "GET";

        headers.set("Accept", "application/json");

        if (options.body && !headers.has("Content-Type")) {
            headers.set("Content-Type", "application/json");
        }

        if (authorization) {
            headers.set("Authorization", authorization);
        }

        console.log("[mcp] forwarding app request", method, path);

        const response = await fetch(`${appBaseUrl}${path}`, {
            ...options,
            headers,
            signal: AbortSignal.timeout(30000),
        });

        console.log("[mcp] app response received", method, path, response.status);

        const contentType = response.headers.get("content-type") || "";
        const body = contentType.includes("application/json")
            ? await response.json()
            : await response.text();

        if (!response.ok) {
            throw new Error(`B2B app request failed with ${response.status}: ${JSON.stringify(body)}`);
        }

        return body as JsonValue;
    }

    return {
        get: (path: string) => requestApi(path),
        post: (path: string, body: JsonValue) => requestApi(path, {
            method: "POST",
            body: JSON.stringify(body),
        }),
        put: (path: string, body: JsonValue) => requestApi(path, {
            method: "PUT",
            body: JSON.stringify(body),
        }),
    };
}

function toToolContent(data: JsonValue) {
    return {
        content: [
            {
                type: "text" as const,
                text: typeof data === "string" ? data : JSON.stringify(data, null, 2),
            },
        ],
    };
}

function createEnterpriseMcpServer(authorization?: string) {
    const api = createApiClient(authorization);
    const tokenPayload = decodeJwtPayload(getBearerToken(authorization));
    const server = new McpServer({
        name: "wayfinder-enterprise-mcp",
        version: "1.0.0",
    });

    server.tool(
        "get_current_access_context",
        "Get the authenticated subject, actor, roles, organization, and scopes from the current access token.",
        {},
        async () => toToolContent({
            actor: tokenPayload?.act ?? null,
            organizationId: typeof tokenPayload?.org_id === "string" ? tokenPayload.org_id : "",
            roles: Array.isArray(tokenPayload?.roles)
                ? tokenPayload.roles.map(String)
                : typeof tokenPayload?.roles === "string"
                ? [tokenPayload.roles]
                : [],
            scopes: typeof tokenPayload?.scope === "string" ? tokenPayload.scope.split(" ") : [],
            subject: typeof tokenPayload?.sub === "string" ? tokenPayload.sub : "",
        } as JsonValue),
    );

    server.tool(
        "get_travel_policy",
        "Get the active travel policy for the authenticated organization. Use this before answering travel-policy questions and before creating a flight booking.",
        {},
        async () => {
            console.log("[mcp] get_travel_policy tool invoked");

            return toToolContent(await api.get("/api/travel-policies"));
        },
    );

    server.tool(
        "update_travel_policy",
        "Update the active travel policy for the authenticated organization.",
        {
            domestic_cabin: z.enum(["Economy", "Premium Economy", "Business", "First Class"]).optional(),
            max_flight_price: z.number().int().min(0).max(100000).optional(),
            price_cap_percent: z.number().int().min(0).max(200).optional(),
        },
        async (policy) => toToolContent(await api.put("/api/travel-policies", policy as JsonValue)),
    );

    server.tool(
        "list_organization_users",
        "List users in the authenticated organization.",
        {},
        async () => toToolContent(await api.get("/api/organization/users")),
    );

    server.tool(
        "invite_organization_user",
        "Invite a new user to the authenticated organization.",
        {
            email: z.string().email().describe("The employee email address."),
            givenName: z.string().optional().describe("The employee given name."),
            familyName: z.string().optional().describe("The employee family name."),
            role: z.enum(["Admin", "Member", "Idp Manager", "Basic Branding Editor", "Advanced Branding Editor"]).optional(),
        },
        async ({ email, givenName, familyName, role }) => toToolContent(await api.post("/api/organization/users", {
            email,
            givenName: givenName ?? "",
            familyName: familyName ?? "",
            role: role ?? "Member",
        })),
    );

    server.tool(
        "list_organization_roles",
        "List organization roles and assigned user IDs.",
        {},
        async () => toToolContent(await api.get("/api/organization/roles")),
    );

    server.tool(
        "search_enterprise_flights",
        "Search available flight options from the Wayfinder booking database.",
        {
            from: z.string().optional().describe("Origin city, for example New York."),
            to: z.string().optional().describe("Destination city, for example Los Angeles."),
            cabin: z.enum(["Economy", "Premium Economy", "Business", "First Class"]).optional(),
        },
        async ({ from, to, cabin }) => {
            const params = new URLSearchParams();

            if (from) params.set("from", from);
            if (to) params.set("to", to);
            if (cabin) params.set("cabin", cabin);

            const path = `/api/flights${params.size > 0 ? `?${params.toString()}` : ""}`;

            return toToolContent(await api.get(path));
        },
    );

    server.tool(
        "list_flight_bookings",
        "List flight bookings visible to the authenticated user.",
        {
            all: z.boolean().optional().describe("When true, admins can list all organization bookings."),
        },
        async ({ all }) => toToolContent(await api.get(`/api/bookings${all ? "?all=true" : ""}`)),
    );

    server.tool(
        "create_flight_booking",
        "Create a flight booking for the authenticated user. Only use after get_travel_policy has been called in the current turn and a single matching flight is clear.",
        {
            bookedByName: z.string().optional().describe("Display name of the user making the booking."),
            bookedForName: z.string().optional().describe("Display name of the traveler when an admin books for someone else."),
            bookedForUserId: z.string().optional().describe("User ID of the traveler when an admin books for someone else."),
            flightId: z.string().describe("The ID of the flight to book."),
            travelers: z.number().int().min(1).max(9).optional().describe("Number of travelers."),
        },
        async ({ bookedByName, bookedForName, bookedForUserId, flightId, travelers }) => toToolContent(await api.post("/api/bookings", {
            bookedByName: bookedByName ?? "AI-assisted user",
            bookedForName: bookedForName ?? "",
            bookedForUserId: bookedForUserId ?? "",
            flightId,
            travelers: travelers ?? 1,
        })),
    );

    return server;
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = [];

    for await (const chunk of request) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }

    if (chunks.length === 0) {
        return undefined;
    }

    const body = Buffer.concat(chunks).toString("utf8");

    return body ? JSON.parse(body) : undefined;
}

function sendJson(response: ServerResponse, statusCode: number, body: JsonValue) {
    response.writeHead(statusCode, { "Content-Type": "application/json" });
    response.end(JSON.stringify(body));
}

const httpServer = createServer(async (request, response) => {
    if (request.url === "/health") {
        sendJson(response, 200, { status: "ok" });

        return;
    }

    if (request.url !== "/mcp") {
        sendJson(response, 404, { error: "Not found" });

        return;
    }

    if (request.method !== "POST") {
        sendJson(response, 405, { error: "Method not allowed" });

        return;
    }

    try {
        const server = createEnterpriseMcpServer(getAuthorizationHeader(request));
        const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: undefined,
        });
        const body = await readJsonBody(request);

        response.on("close", () => {
            transport.close();
        });

        await server.connect(transport);
        await transport.handleRequest(request, response, body);
    } catch (error) {
        console.error("Error handling MCP request:", error);

        if (!response.headersSent) {
            sendJson(response, 500, {
                error: error instanceof Error ? error.message : "Failed to handle MCP request.",
            });
        }
    }
});

httpServer.listen(port, host, () => {
    console.log(`Wayfinder Enterprise MCP server is running at http://${host}:${port}/mcp`);
    console.log(`Health check is available at http://${host}:${port}/health`);
});
