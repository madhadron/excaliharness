// Makes [[T-NNN]] and [[path/name]] clickable in Markdown (D-015, D-032).
import * as vscode from "vscode";
import { findWikilinks, resolveWikilink } from "./editorText";

export class WikilinkProvider implements vscode.DocumentLinkProvider {
  constructor(private readonly root: string) {}

  provideDocumentLinks(document: vscode.TextDocument): vscode.DocumentLink[] {
    const links: vscode.DocumentLink[] = [];
    for (const match of findWikilinks(document.getText())) {
      const target = resolveWikilink(this.root, match.target);
      if (!target) continue;
      const link = new vscode.DocumentLink(new vscode.Range(match.line, match.start, match.line, match.end), vscode.Uri.file(target));
      link.tooltip = `Open ${vscode.workspace.asRelativePath(target)}`;
      links.push(link);
    }
    return links;
  }
}
