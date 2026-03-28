import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { createClient, type Client } from "@libsql/client";
import express, { type Request, type Response } from "express";
import { z } from "zod";

// ── Environment ──────────────────────────────────────────────────────────────

const TURSO_URL = process.env.TURSO_DATABASE_URL;
const TURSO_TOKEN = process.env.TURSO_AUTH_TOKEN;
const PORT = parseInt(process.env.PORT ?? "3000", 10);

if (!TURSO_URL || !TURSO_TOKEN) {
  console.error("Missing required env vars: TURSO_DATABASE_URL, TURSO_AUTH_TOKEN");
  process.exit(1);
}

// ── Turso client ─────────────────────────────────────────────────────────────

const db: Client = createClient({
  url: TURSO_URL,
  authToken: TURSO_TOKEN,
});

// ── MCP Server ───────────────────────────────────────────────────────────────

function createMcpServer(): McpServer {
  const server = new McpServer({
    name: "camda-turso",
    version: "1.0.0",
  });

  // ── Tool: list_tables ──────────────────────────────────────────────────────
  server.tool(
    "list_tables",
    "Lista todas as tabelas do banco de dados Turso",
    {},
    async () => {
      const result = await db.execute(
        "SELECT name, type FROM sqlite_master WHERE type IN ('table','view') ORDER BY name"
      );
      const tables = result.rows.map((r) => ({
        name: r[0],
        type: r[1],
      }));
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(tables, null, 2),
          },
        ],
      };
    }
  );

  // ── Tool: describe_table ───────────────────────────────────────────────────
  server.tool(
    "describe_table",
    "Mostra o schema (colunas e tipos) de uma tabela específica",
    { table: z.string().describe("Nome da tabela") },
    async ({ table }) => {
      const [pragma, indexList] = await Promise.all([
        db.execute(`PRAGMA table_info(${JSON.stringify(table)})`),
        db.execute(`PRAGMA index_list(${JSON.stringify(table)})`),
      ]);

      const columns = pragma.rows.map((r) => ({
        cid: r[0],
        name: r[1],
        type: r[2],
        notnull: r[3] === 1,
        default: r[4],
        pk: r[5] === 1,
      }));

      const indexes = indexList.rows.map((r) => ({
        seq: r[0],
        name: r[1],
        unique: r[2] === 1,
      }));

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ table, columns, indexes }, null, 2),
          },
        ],
      };
    }
  );

  // ── Tool: query ────────────────────────────────────────────────────────────
  server.tool(
    "query",
    "Executa uma query SELECT (somente leitura) no banco Turso e retorna os resultados",
    {
      sql: z.string().describe("Query SQL SELECT a ser executada"),
      args: z
        .array(z.union([z.string(), z.number(), z.boolean(), z.null()]))
        .optional()
        .describe("Parâmetros para a query (opcional)"),
    },
    async ({ sql, args }) => {
      const normalized = sql.trim().toUpperCase();
      const allowed = ["SELECT", "WITH", "EXPLAIN"];
      if (!allowed.some((kw) => normalized.startsWith(kw))) {
        return {
          content: [
            {
              type: "text",
              text: "Erro: apenas queries SELECT são permitidas por esta ferramenta. Use a ferramenta 'execute' para escrita.",
            },
          ],
          isError: true,
        };
      }

      const result = await db.execute({
        sql,
        args: (args as any[]) ?? [],
      });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                columns: result.columns,
                rows: result.rows,
                rowsAffected: result.rowsAffected,
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  // ── Tool: execute ──────────────────────────────────────────────────────────
  server.tool(
    "execute",
    "Executa uma instrução de escrita (INSERT, UPDATE, DELETE, CREATE, DROP) no banco Turso",
    {
      sql: z.string().describe("Instrução SQL a ser executada"),
      args: z
        .array(z.union([z.string(), z.number(), z.boolean(), z.null()]))
        .optional()
        .describe("Parâmetros para a instrução (opcional)"),
    },
    async ({ sql, args }) => {
      const result = await db.execute({
        sql,
        args: (args as any[]) ?? [],
      });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                rowsAffected: result.rowsAffected,
                lastInsertRowid: result.lastInsertRowid?.toString(),
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  // ── Tool: batch ────────────────────────────────────────────────────────────
  server.tool(
    "batch",
    "Executa múltiplas instruções SQL em uma transação atômica",
    {
      statements: z
        .array(
          z.object({
            sql: z.string(),
            args: z
              .array(z.union([z.string(), z.number(), z.boolean(), z.null()]))
              .optional(),
          })
        )
        .describe("Lista de instruções SQL a executar em batch"),
    },
    async ({ statements }) => {
      const results = await db.batch(
        statements.map((s) => ({
          sql: s.sql,
          args: (s.args as any[]) ?? [],
        }))
      );

      const summary = results.map((r, i) => ({
        statement: i,
        rowsAffected: r.rowsAffected,
        lastInsertRowid: r.lastInsertRowid?.toString(),
        columns: r.columns,
        rows: r.rows,
      }));

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(summary, null, 2),
          },
        ],
      };
    }
  );

  return server;
}

// ── Express HTTP server with SSE transport ────────────────────────────────────

const app = express();
app.use(express.json());

// CORS — allow claude.ai and any origin to connect
app.use((req: Request, res: Response, next: () => void) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") {
    res.sendStatus(204);
    return;
  }
  next();
});

// One SSEServerTransport per connected session
const sessions = new Map<string, SSEServerTransport>();

app.get("/sse", async (req: Request, res: Response) => {
  const transport = new SSEServerTransport("/messages", res);
  const mcpServer = createMcpServer();

  sessions.set(transport.sessionId, transport);
  res.on("close", () => sessions.delete(transport.sessionId));

  await mcpServer.connect(transport);
});

app.post("/messages", async (req: Request, res: Response) => {
  const sessionId = req.query.sessionId as string;
  const transport = sessions.get(sessionId);
  if (!transport) {
    res.status(404).json({ error: "Session not found" });
    return;
  }
  await transport.handlePostMessage(req, res);
});

app.get("/health", (_req, res) => {
  res.json({ status: "ok", server: "camda-turso-mcp" });
});

app.listen(PORT, () => {
  console.log(`camda-turso MCP server running on port ${PORT}`);
  console.log(`SSE endpoint: http://0.0.0.0:${PORT}/sse`);
});
