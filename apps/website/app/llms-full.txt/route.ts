import { pageMarkdown, source } from '@/lib/docs';

// Every docs page in one file, for agents and LLM tools (llms.txt points here).
export const revalidate = false;

export async function GET() {
  const pages = await Promise.all(source.getPages().map(pageMarkdown));
  return new Response(pages.join('\n\n---\n\n'), { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
}
