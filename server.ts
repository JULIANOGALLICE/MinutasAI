import express from "express";
import { createServer as createViteServer } from "vite";
import cookieParser from "cookie-parser";
import Database from "better-sqlite3";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";

const db = new Database("minutas.db");
const JWT_SECRET = process.env.JWT_SECRET || "super-secret-key-for-cartorio-ai";

db.exec(`
  CREATE TABLE IF NOT EXISTS minutas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT,
    content TEXT NOT NULL,
    ai_instructions TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'comum',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS settings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    key TEXT UNIQUE NOT NULL,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    minuta_id INTEGER,
    minuta_name TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS roles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

try {
  db.exec("ALTER TABLE minutas ADD COLUMN ai_instructions TEXT;");
} catch (e) {
  // Column likely already exists, ignore
}

// Seed initial roles
const initialRoles = [
  'Vendedor(a)', 'Comprador(a)', 'Doador(a)', 'Donatário(a)',
  'Inventariante', 'Herdeiro(a)', 'Meeiro(a)', 'Falecido(a)',
  'Divorciando(a)', 'Outorgante', 'Outorgado(a)', 'Testador(a)',
  'Cônjuge/Companheiro(a)', 'Anuente', 'Testemunha', 'Não Participa (Ignorar)'
];

const roleCount = db.prepare("SELECT COUNT(*) as count FROM roles").get() as any;
if (roleCount.count === 0) {
  const insertRole = db.prepare("INSERT INTO roles (name) VALUES (?)");
  const insertMany = db.transaction((roles) => {
    for (const role of roles) insertRole.run(role);
  });
  insertMany(initialRoles);
}

// Seed initial admin user
const adminUser = db.prepare("SELECT * FROM users WHERE username = 'adm'").get();
if (!adminUser) {
  const hashedPassword = bcrypt.hashSync("adm", 10);
  db.prepare("INSERT INTO users (username, password, role) VALUES (?, ?, ?)").run("adm", hashedPassword, "administrador");
}

// Seed initial AI instructions
const defaultInstructions = `Você é um Tabelião de Notas experiente no Brasil.
Com base nos documentos fornecidos, e nas seguintes informações:

Tipo de Escritura solicitada: {{deedType}}

Partes envolvidas e seus respectivos papéis na escritura:
{{rolesText}}
{{additionalDetailsText}}
Por favor, redija a MINUTA COMPLETA da escritura pública solicitada.
Instruções RIGOROSAS:
1. USO INTEGRAL DO MODELO: É OBRIGATÓRIO utilizar o texto do MODELO fornecido de forma INTEGRAL. Mantenha toda a estrutura, todas as cláusulas, jargões e formatação exatamente iguais às do modelo. NÃO APAGUE A ESTRUTURA COMO UM TODO.
2. MARCADORES ESPECÍFICOS: O protocolo geral deve ser mantido estritamente como "[[PROTGERAL]]". A data inicial deve ser mantida estritamente como "[[DATAEXTENSO]]".
3. NÃO CORTE O CABEÇALHO/RODAPÉ E DADOS DO CARTÓRIO: Você DEVE manter a parte inicial (protocolo geral, livro, folha, dados do cartório, dados do oficial/tabelião, selos) e a parte final (assinaturas, encerramento) EXATAMENTE como constam no modelo fornecido. NÃO altere o nome do cartório nem o nome do tabelião que constam no modelo.
4. SUBSTITUIÇÃO DE DADOS: Altere no modelo APENAS os dados das partes, do imóvel, valores e datas, substituindo-os pelas informações encontradas nos documentos enviados.
5. QUALIFICAÇÃO COMPLETA: A qualificação das partes deve ser extremamente detalhada, contendo: nome completo, nacionalidade, documento de identificação (RG, CNH, etc.) com órgão emissor, CPF, profissão, estado civil e, se casado/divorciado/viúvo, a descrição completa da certidão de casamento (livro, folha, termo, cartório e data).
6. DADOS FALTANTES (ESPAÇOS EM BRANCO): Se qualquer informação necessária para a qualificação ou para a escritura NÃO estiver presente nos documentos enviados (ex: profissão, endereço, dados do cônjuge, valores, datas, dados do imóvel), VOCÊ NÃO DEVE INVENTAR NEM OMITIR. Em vez disso, deixe o que falta no formato "-------[NOME_DA_INFORMACAO]------" (por exemplo: "-------PROFISSAO------", "-------ESTADO CIVIL------", "-------ENDERECO------").
7. INFORMAÇÕES ADICIONAIS: Se houver "Informações e Cláusulas Adicionais" fornecidas acima (como forma de pagamento, usufruto, incomunicabilidade, etc.), você DEVE redigir e incluir essas cláusulas no corpo da escritura, adaptando-as ao estilo do modelo.
8. Não resuma a escritura. O resultado final deve ser a escritura completa, pronta para ser lida e preenchida nos espaços faltantes.
9. Retorne o texto formatado em Markdown para facilitar a leitura.`;

const aiInstructions = db.prepare("SELECT * FROM settings WHERE key = 'ai_instructions'").get();
if (!aiInstructions) {
  db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run("ai_instructions", defaultInstructions);
}

// Auth Middleware
const authenticate = (req: any, res: any, next: any) => {
  const token = req.cookies.token;
  if (!token) return res.status(401).json({ error: "Não autorizado" });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    res.status(401).json({ error: "Token inválido" });
  }
};

const requireAdmin = (req: any, res: any, next: any) => {
  if (req.user.role !== 'administrador') {
    return res.status(403).json({ error: "Acesso negado" });
  }
  next();
};

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(cookieParser());
  app.use(express.json({ limit: '50mb' }));

  // API routes
  app.get("/api/health", (req, res) => {
    res.json({ status: "ok" });
  });

  // Auth API
  app.post("/api/login", (req, res) => {
    const { username, password } = req.body;
    const user = db.prepare("SELECT * FROM users WHERE username = ?").get(username) as any;
    if (!user || !bcrypt.compareSync(password, user.password)) {
      return res.status(401).json({ error: "Usuário ou senha inválidos" });
    }
    const token = jwt.sign({ id: user.id, username: user.username, role: user.role }, JWT_SECRET, { expiresIn: '24h' });
    res.cookie('token', token, { 
      httpOnly: true, 
      secure: false,
      sameSite: 'lax'
    });
    res.json({ id: user.id, username: user.username, role: user.role });
  });

  app.post("/api/logout", (req, res) => {
    res.clearCookie('token');
    res.json({ success: true });
  });

  app.get("/api/me", authenticate, (req: any, res) => {
    res.json(req.user);
  });

  // Users API (Admin only)
  app.get("/api/users", authenticate, requireAdmin, (req, res) => {
    const users = db.prepare("SELECT id, username, role, created_at FROM users ORDER BY created_at DESC").all();
    res.json(users);
  });

  app.post("/api/users", authenticate, requireAdmin, (req, res) => {
    const { username, password, role } = req.body;
    if (!username || !password || !role) return res.status(400).json({ error: "Dados inválidos" });
    try {
      const hashedPassword = bcrypt.hashSync(password, 10);
      const stmt = db.prepare("INSERT INTO users (username, password, role) VALUES (?, ?, ?)");
      const info = stmt.run(username, hashedPassword, role);
      res.json({ id: info.lastInsertRowid, username, role });
    } catch (error: any) {
      if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
        return res.status(400).json({ error: "Usuário já existe" });
      }
      res.status(500).json({ error: "Erro ao criar usuário" });
    }
  });

  app.delete("/api/users/:id", authenticate, requireAdmin, (req, res) => {
    try {
      db.prepare("DELETE FROM users WHERE id = ?").run(req.params.id);
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ error: "Erro ao deletar usuário" });
    }
  });

  // Settings API (Admin only)
  app.get("/api/settings/ai_instructions", authenticate, requireAdmin, (req, res) => {
    const setting = db.prepare("SELECT value FROM settings WHERE key = 'ai_instructions'").get() as any;
    res.json({ instructions: setting?.value || '' });
  });

  app.put("/api/settings/ai_instructions", authenticate, requireAdmin, (req, res) => {
    const { instructions } = req.body;
    if (!instructions) return res.status(400).json({ error: "Instruções são obrigatórias" });
    try {
      db.prepare("UPDATE settings SET value = ? WHERE key = 'ai_instructions'").run(instructions);
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ error: "Erro ao atualizar instruções" });
    }
  });

  app.get("/api/settings/google", authenticate, requireAdmin, (req, res) => {
    const clientId = db.prepare("SELECT value FROM settings WHERE key = 'google_client_id'").get() as any;
    const clientSecret = db.prepare("SELECT value FROM settings WHERE key = 'google_client_secret'").get() as any;
    res.json({
      clientId: clientId?.value || '',
      clientSecret: clientSecret?.value || ''
    });
  });

  app.put("/api/settings/google", authenticate, requireAdmin, (req, res) => {
    const { clientId, clientSecret } = req.body;
    try {
      const stmt = db.prepare(`
        INSERT INTO settings (key, value) VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `);
      stmt.run('google_client_id', clientId || '');
      stmt.run('google_client_secret', clientSecret || '');
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ error: "Erro ao atualizar configurações do Google" });
    }
  });

  app.get("/api/settings/gemini", authenticate, (req, res) => {
    const apiKey = db.prepare("SELECT value FROM settings WHERE key = 'gemini_api_key'").get() as any;
    res.json({
      apiKey: apiKey?.value || ''
    });
  });

  app.put("/api/settings/gemini", authenticate, requireAdmin, (req, res) => {
    const { apiKey } = req.body;
    try {
      const stmt = db.prepare(`
        INSERT INTO settings (key, value) VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `);
      stmt.run('gemini_api_key', apiKey || '');
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ error: "Erro ao atualizar chave do Gemini" });
    }
  });

  app.put("/api/users/password", authenticate, (req: any, res) => {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: "Senhas são obrigatórias" });
    }
    try {
      const user = db.prepare("SELECT * FROM users WHERE id = ?").get(req.user.id) as any;
      if (!bcrypt.compareSync(currentPassword, user.password)) {
        return res.status(401).json({ error: "Senha atual incorreta" });
      }
      const hashedNewPassword = bcrypt.hashSync(newPassword, 10);
      db.prepare("UPDATE users SET password = ? WHERE id = ?").run(hashedNewPassword, req.user.id);
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ error: "Erro ao alterar senha" });
    }
  });

  // History API
  app.get("/api/history", authenticate, (req: any, res) => {
    try {
      let history;
      if (req.user.role === 'administrador') {
        history = db.prepare(`
          SELECT h.*, u.username 
          FROM history h 
          JOIN users u ON h.user_id = u.id 
          ORDER BY h.created_at DESC
        `).all();
      } else {
        history = db.prepare(`
          SELECT h.*, u.username 
          FROM history h 
          JOIN users u ON h.user_id = u.id 
          WHERE h.user_id = ? 
          ORDER BY h.created_at DESC
        `).all(req.user.id);
      }
      res.json(history);
    } catch (error) {
      res.status(500).json({ error: "Erro ao buscar histórico" });
    }
  });

  app.post("/api/history", authenticate, (req: any, res) => {
    const { minuta_id, minuta_name, content } = req.body;
    try {
      const stmt = db.prepare("INSERT INTO history (user_id, minuta_id, minuta_name, content) VALUES (?, ?, ?, ?)");
      const info = stmt.run(req.user.id, minuta_id || null, minuta_name, content);
      res.json({ id: info.lastInsertRowid });
    } catch (error) {
      res.status(500).json({ error: "Erro ao salvar no histórico" });
    }
  });

  app.delete("/api/history", authenticate, (req: any, res) => {
    const { ids } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: "IDs são obrigatórios" });
    }
    
    try {
      const placeholders = ids.map(() => '?').join(',');
      let stmt;
      let info;
      
      if (req.user.role === 'administrador') {
        stmt = db.prepare(`DELETE FROM history WHERE id IN (${placeholders})`);
        info = stmt.run(...ids);
      } else {
        stmt = db.prepare(`DELETE FROM history WHERE user_id = ? AND id IN (${placeholders})`);
        info = stmt.run(req.user.id, ...ids);
      }
      
      res.json({ success: true, deletedCount: info.changes });
    } catch (error) {
      res.status(500).json({ error: "Erro ao deletar histórico" });
    }
  });

  // Minutas API (Protect with authenticate)
  app.get("/api/minutas", authenticate, (req, res) => {
    try {
      const minutas = db.prepare("SELECT * FROM minutas ORDER BY created_at DESC").all();
      res.json(minutas);
    } catch (error) {
      res.status(500).json({ error: "Erro ao buscar minutas" });
    }
  });

  app.get("/api/minutas/:id", authenticate, (req, res) => {
    try {
      const minuta = db.prepare("SELECT * FROM minutas WHERE id = ?").get(req.params.id);
      if (!minuta) {
        return res.status(404).json({ error: "Minuta não encontrada" });
      }
      res.json(minuta);
    } catch (error) {
      res.status(500).json({ error: "Erro ao buscar minuta" });
    }
  });

  app.post("/api/minutas", authenticate, requireAdmin, (req, res) => {
    const { name, description, content, ai_instructions } = req.body;
    if (!name || !content) {
      return res.status(400).json({ error: "Nome e conteúdo são obrigatórios" });
    }
    try {
      const stmt = db.prepare("INSERT INTO minutas (name, description, content, ai_instructions) VALUES (?, ?, ?, ?)");
      const info = stmt.run(name, description, content, ai_instructions || null);
      res.json({ id: info.lastInsertRowid, name, description, content, ai_instructions });
    } catch (error) {
      res.status(500).json({ error: "Erro ao criar minuta" });
    }
  });

  app.put("/api/minutas/:id", authenticate, requireAdmin, (req, res) => {
    const { name, description, content, ai_instructions } = req.body;
    if (!name || !content) {
      return res.status(400).json({ error: "Nome e conteúdo são obrigatórios" });
    }
    try {
      const stmt = db.prepare("UPDATE minutas SET name = ?, description = ?, content = ?, ai_instructions = ? WHERE id = ?");
      const info = stmt.run(name, description, content, ai_instructions || null, req.params.id);
      if (info.changes === 0) {
        return res.status(404).json({ error: "Minuta não encontrada" });
      }
      res.json({ id: req.params.id, name, description, content, ai_instructions });
    } catch (error) {
      res.status(500).json({ error: "Erro ao atualizar minuta" });
    }
  });

  app.delete("/api/minutas/:id", authenticate, requireAdmin, (req, res) => {
    try {
      const stmt = db.prepare("DELETE FROM minutas WHERE id = ?");
      const info = stmt.run(req.params.id);
      if (info.changes === 0) {
        return res.status(404).json({ error: "Minuta não encontrada" });
      }
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ error: "Erro ao deletar minuta" });
    }
  });

  // Roles API
  app.get("/api/roles", authenticate, (req, res) => {
    try {
      const roles = db.prepare("SELECT * FROM roles ORDER BY name ASC").all();
      res.json(roles);
    } catch (error) {
      res.status(500).json({ error: "Erro ao buscar papéis" });
    }
  });

  app.post("/api/roles", authenticate, requireAdmin, (req, res) => {
    const { name } = req.body;
    if (!name) {
      return res.status(400).json({ error: "Nome do papel é obrigatório" });
    }
    try {
      const stmt = db.prepare("INSERT INTO roles (name) VALUES (?)");
      const info = stmt.run(name);
      res.json({ id: info.lastInsertRowid, name });
    } catch (error: any) {
      if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
        return res.status(400).json({ error: "Papel já existe" });
      }
      res.status(500).json({ error: "Erro ao criar papel" });
    }
  });

  app.put("/api/roles/:id", authenticate, requireAdmin, (req, res) => {
    const { name } = req.body;
    if (!name) {
      return res.status(400).json({ error: "Nome do papel é obrigatório" });
    }
    try {
      const stmt = db.prepare("UPDATE roles SET name = ? WHERE id = ?");
      const info = stmt.run(name, req.params.id);
      if (info.changes === 0) {
        return res.status(404).json({ error: "Papel não encontrado" });
      }
      res.json({ id: req.params.id, name });
    } catch (error: any) {
      if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
        return res.status(400).json({ error: "Papel já existe" });
      }
      res.status(500).json({ error: "Erro ao atualizar papel" });
    }
  });

  app.delete("/api/roles/:id", authenticate, requireAdmin, (req, res) => {
    try {
      const stmt = db.prepare("DELETE FROM roles WHERE id = ?");
      const info = stmt.run(req.params.id);
      if (info.changes === 0) {
        return res.status(404).json({ error: "Papel não encontrado" });
      }
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ error: "Erro ao deletar papel" });
    }
  });

  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static('dist'));
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
