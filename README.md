# camda-mcp

Servidor MCP (Model Context Protocol) que expõe seu banco **Turso** (libSQL) para o Claude via HTTP/SSE. Deploy no Railway.

## Ferramentas disponíveis

| Ferramenta | Descrição |
|---|---|
| `list_tables` | Lista todas as tabelas e views |
| `describe_table` | Mostra colunas, tipos e índices de uma tabela |
| `query` | Executa SELECT (somente leitura) |
| `execute` | Executa INSERT / UPDATE / DELETE / DDL |
| `batch` | Executa múltiplas instruções em transação |

## Deploy no Railway

### 1. Variáveis de ambiente no Railway

No painel do Railway, adicione as seguintes variáveis:

```
TURSO_DATABASE_URL   = libsql://seu-banco.turso.io
TURSO_AUTH_TOKEN     = seu-token-turso
MCP_AUTH_TOKEN       = token-secreto-para-o-mcp   (opcional, mas recomendado)
```

> `PORT` é injetada automaticamente pelo Railway.

### 2. Conectar o repositório

1. No Railway, crie um novo projeto → **Deploy from GitHub repo**
2. Selecione `leolira1/camda-mcp`
3. O Railway detecta o `Dockerfile` e faz o build automaticamente

### 3. Obter a URL pública

Após o deploy, vá em **Settings → Networking → Generate Domain**.
A URL do endpoint SSE será:

```
https://seu-projeto.up.railway.app/sse
```

## Configurar no Claude

Adicione ao `claude_desktop_config.json` (ou pelo painel claude.ai):

```json
{
  "mcpServers": {
    "camda-turso": {
      "url": "https://seu-projeto.up.railway.app/sse",
      "headers": {
        "Authorization": "Bearer seu-mcp-auth-token"
      }
    }
  }
}
```

## Desenvolvimento local

```bash
cp .env.example .env
# preencha o .env com suas credenciais Turso

npm install
npm run dev
```

O servidor sobe em `http://localhost:3000`.
