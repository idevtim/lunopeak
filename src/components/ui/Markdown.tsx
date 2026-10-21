import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "@/lib/utils";

const components: Components = {
  p: ({ children }) => (
    <p className="text-sm leading-relaxed text-zinc-800 dark:text-zinc-200 [&:not(:last-child)]:mb-2">
      {children}
    </p>
  ),
  a: ({ children, href }) => (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="text-blue-600 underline-offset-2 hover:underline dark:text-blue-400"
    >
      {children}
    </a>
  ),
  ul: ({ children }) => (
    <ul className="my-2 ml-5 list-disc space-y-1 text-sm text-zinc-800 dark:text-zinc-200 marker:text-zinc-400 dark:marker:text-zinc-600">
      {children}
    </ul>
  ),
  ol: ({ children }) => (
    <ol className="my-2 ml-5 list-decimal space-y-1 text-sm text-zinc-800 dark:text-zinc-200 marker:text-zinc-400 dark:marker:text-zinc-600">
      {children}
    </ol>
  ),
  li: ({ children }) => <li className="leading-relaxed">{children}</li>,
  h1: ({ children }) => (
    <h1 className="mt-3 mb-2 text-base font-semibold text-zinc-900 dark:text-zinc-50">
      {children}
    </h1>
  ),
  h2: ({ children }) => (
    <h2 className="mt-3 mb-2 text-sm font-semibold text-zinc-900 dark:text-zinc-50">
      {children}
    </h2>
  ),
  h3: ({ children }) => (
    <h3 className="mt-2 mb-1 text-sm font-semibold text-zinc-900 dark:text-zinc-50">
      {children}
    </h3>
  ),
  strong: ({ children }) => (
    <strong className="font-semibold text-zinc-900 dark:text-zinc-50">
      {children}
    </strong>
  ),
  em: ({ children }) => <em className="italic">{children}</em>,
  blockquote: ({ children }) => (
    <blockquote className="my-2 border-l-2 border-black/[0.12] dark:border-white/[0.12] pl-3 text-sm text-zinc-600 dark:text-zinc-400">
      {children}
    </blockquote>
  ),
  hr: () => <hr className="my-3 border-black/[0.06] dark:border-white/[0.06]" />,
  code: ({ className, children, ...props }) => {
    const isBlock = /language-/.test(className ?? "");
    if (isBlock) {
      return (
        <code
          className={cn(
            "block w-full font-mono text-[12px] leading-relaxed text-zinc-800 dark:text-zinc-200",
            className,
          )}
          {...props}
        >
          {children}
        </code>
      );
    }
    return (
      <code
        className="rounded border border-black/[0.06] dark:border-white/[0.06] bg-black/[0.04] dark:bg-white/[0.04] px-1 py-0.5 font-mono text-[12px] text-zinc-800 dark:text-zinc-200"
        {...props}
      >
        {children}
      </code>
    );
  },
  pre: ({ children }) => (
    <pre className="my-2 overflow-x-auto rounded-lg border border-black/[0.06] dark:border-white/[0.06] bg-zinc-100/70 dark:bg-zinc-950/50 p-3">
      {children}
    </pre>
  ),
  table: ({ children }) => (
    <div className="my-2 overflow-x-auto rounded-lg border border-black/[0.06] dark:border-white/[0.06]">
      <table className="w-full border-collapse text-sm">{children}</table>
    </div>
  ),
  thead: ({ children }) => (
    <thead className="bg-black/[0.03] dark:bg-white/[0.03]">{children}</thead>
  ),
  th: ({ children }) => (
    <th className="border-b border-black/[0.06] dark:border-white/[0.06] px-3 py-1.5 text-left text-xs font-semibold text-zinc-700 dark:text-zinc-300">
      {children}
    </th>
  ),
  td: ({ children }) => (
    <td className="border-b border-black/[0.04] dark:border-white/[0.04] px-3 py-1.5 text-zinc-700 dark:text-zinc-300">
      {children}
    </td>
  ),
};

export function Markdown({ children }: { children: string }) {
  return (
    <div className="text-sm">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {children}
      </ReactMarkdown>
    </div>
  );
}
