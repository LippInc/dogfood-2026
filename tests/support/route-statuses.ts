import path from "node:path";
import ts from "typescript";

// Every HTTP status a route handler can answer, read from the code: the handler's own answers and everything it
// calls inside src/, followed through imports to the thrown errors and the refusals authorize() builds. It is an
// over-approximation (a branch the handler never takes still counts), so a status it finds and the API reference
// leaves out is either documented or explained in tests/api-statuses.test.ts; a status the reference lists and no
// code path gives is a promise the portal does not keep.

/** The status each error class carries. AuthzError carries its refusal's, which the { status: 4xx } rule reads. */
const CLASS_STATUS: Record<string, number[]> = {
  AuthzError: [],
  NotFoundError: [404],
  ValidationError: [422],
  ConflictError: [409],
  PrizeAwardedError: [409],
  RateLimitedError: [429],
};

export type Found = {
  /** status -> the first place in the code that gives it ("src/server/dal/teams.ts:115") */
  statuses: Map<number, string>;
  /** places whose status the reader could not tell (a variable status); the test asks for each to be explained */
  unreadable: string[];
};

type Direct = { statuses: Map<number, string>; unreadable: string[]; next: ts.Node[] };

export function statusReader(root: string, entryFiles: string[]) {
  const config = ts.getParsedCommandLineOfConfigFile(path.join(root, "tsconfig.json"), {}, {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: (d) => {
      throw new Error(ts.flattenDiagnosticMessageText(d.messageText, "\n"));
    },
  })!;
  const program = ts.createProgram(entryFiles, { ...config.options, noEmit: true, incremental: false, tsBuildInfoFile: undefined });
  const checker = program.getTypeChecker();
  const src = path.resolve(root, "src").toLowerCase() + path.sep;
  const entries = new Set(entryFiles.map((f) => path.resolve(f).toLowerCase()));
  // the portal's own code, and the entry files themselves (a test's made-up handler and its helpers)
  const ours = (sf: ts.SourceFile) => {
    const file = path.resolve(sf.fileName).toLowerCase();
    return !sf.isDeclarationFile && (file.startsWith(src) || entries.has(file));
  };
  const where = (node: ts.Node) => {
    const sf = node.getSourceFile();
    const rel = path.relative(root, path.resolve(sf.fileName)).split(path.sep).join("/");
    return `${rel}:${sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1}`;
  };

  function declarationOf(node: ts.Node): ts.Declaration | undefined {
    let symbol = checker.getSymbolAtLocation(node);
    if (!symbol) return undefined;
    if (symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
    return symbol.valueDeclaration ?? symbol.declarations?.[0];
  }

  /** What to read when code refers to this declaration: a function's body, a constant's value. */
  function readable(decl: ts.Declaration | undefined): ts.Node | undefined {
    if (!decl || !ours(decl.getSourceFile())) return undefined;
    if (ts.isFunctionDeclaration(decl) || ts.isMethodDeclaration(decl) || ts.isArrowFunction(decl) || ts.isFunctionExpression(decl)) return decl;
    if (ts.isVariableDeclaration(decl) && decl.initializer) return decl.initializer;
    if (ts.isPropertyAssignment(decl)) return decl.initializer;
    return undefined;
  }

  function classStatus(decl: ts.ClassDeclaration): number[] | "http" | null {
    const name = decl.name?.text ?? "";
    if (name === "HttpError") return "http";
    if (name in CLASS_STATUS) return CLASS_STATUS[name]!;
    // a subclass of HttpError nobody taught this reader: say so rather than guess
    const heritage = decl.heritageClauses?.flatMap((c) => c.types.map((t) => t.expression.getText())) ?? [];
    return heritage.some((h) => h === "HttpError" || h in CLASS_STATUS) ? null : [];
  }

  const numbersIn = (node: ts.Node): number[] => {
    const out: number[] = [];
    const walk = (n: ts.Node) => {
      if (ts.isNumericLiteral(n)) out.push(Number(n.text));
      ts.forEachChild(n, walk);
    };
    walk(node);
    return out.filter((n) => n >= 100 && n <= 599);
  };

  const memo = new Map<ts.Node, Direct>();
  function direct(node: ts.Node): Direct {
    const hit = memo.get(node);
    if (hit) return hit;
    const d: Direct = { statuses: new Map(), unreadable: [], next: [] };
    memo.set(node, d);
    const add = (status: number, at: ts.Node) => {
      if (!d.statuses.has(status)) d.statuses.set(status, where(at));
    };
    const visit = (n: ts.Node) => {
      if (ts.isNewExpression(n)) {
        const cls = declarationOf(n.expression);
        if (cls && ts.isClassDeclaration(cls) && ours(cls.getSourceFile())) {
          const s = classStatus(cls);
          if (s === "http") {
            const first = n.arguments?.[0];
            if (first && ts.isNumericLiteral(first)) add(Number(first.text), n);
            else d.unreadable.push(`${where(n)} new HttpError(${first?.getText() ?? ""}, ...)`);
          } else if (s === null) d.unreadable.push(`${where(n)} new ${cls.name?.text}(...): add it to CLASS_STATUS in tests/support/route-statuses.ts`);
          else for (const status of s) add(status, n);
        }
      } else if (ts.isCallExpression(n)) {
        const callee = ts.isPropertyAccessExpression(n.expression) ? n.expression.name : n.expression;
        const decl = declarationOf(callee);
        // json(body, status) from src/server/http.ts: 200 unless a status is given
        if (decl && ts.isFunctionDeclaration(decl) && decl.name?.text === "json" && /src[\\/]server[\\/]http\.ts$/.test(decl.getSourceFile().fileName)) {
          const status = n.arguments[1];
          if (!status) add(200, n);
          else {
            const nums = numbersIn(status);
            if (nums.length) for (const s of nums) add(s, n);
            else if (!/^err\.status$/.test(status.getText())) d.unreadable.push(`${where(n)} json(..., ${status.getText()})`);
          }
        }
      } else if (ts.isPropertyAssignment(n) && n.name.getText() === "status" && ts.isNumericLiteral(n.initializer)) {
        const s = Number(n.initializer.text);
        if (s >= 100 && s <= 599) add(s, n);
      } else if (ts.isIdentifier(n)) {
        const target = readable(declarationOf(n));
        if (target && target !== node) d.next.push(target);
      }
      ts.forEachChild(n, visit);
    };
    visit(node);
    return d;
  }

  /** Everything reachable from one exported handler, e.g. ("src/app/api/join/[code]/route.ts", "POST"). */
  function statusesOf(file: string, method: string): Found | null {
    const sf = program.getSourceFile(file) ?? program.getSourceFiles().find((f) => path.resolve(f.fileName).toLowerCase() === path.resolve(file).toLowerCase());
    if (!sf) return null;
    let start: ts.Node | undefined;
    ts.forEachChild(sf, (n) => {
      if (ts.isFunctionDeclaration(n) && n.name?.text === method && n.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) start = n;
      if (ts.isVariableStatement(n) && n.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) {
        for (const v of n.declarationList.declarations) if (v.name.getText() === method && v.initializer) start = v.initializer;
      }
    });
    if (!start) return null;
    const found: Found = { statuses: new Map(), unreadable: [] };
    const seen = new Set<ts.Node>();
    const queue = [start];
    while (queue.length) {
      const n = queue.pop()!;
      if (seen.has(n)) continue;
      seen.add(n);
      const d = direct(n);
      for (const [s, at] of d.statuses) if (!found.statuses.has(s)) found.statuses.set(s, at);
      found.unreadable.push(...d.unreadable);
      queue.push(...d.next);
    }
    return found;
  }

  return { statusesOf };
}
