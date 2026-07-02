"use client";

import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "@/lib/utils";

interface MarkdownProps {
  children: string;
  className?: string;
}

const components: Components = {
  p: ({ className, ...props }) => (
    <p className={cn("my-2 whitespace-pre-wrap first:mt-0 last:mb-0", className)} {...props} />
  ),
  h1: ({ className, ...props }) => (
    <h1 className={cn("mt-4 mb-2 text-xl font-semibold first:mt-0", className)} {...props} />
  ),
  h2: ({ className, ...props }) => (
    <h2 className={cn("mt-4 mb-2 text-lg font-semibold first:mt-0", className)} {...props} />
  ),
  h3: ({ className, ...props }) => (
    <h3 className={cn("mt-3 mb-2 text-base font-semibold first:mt-0", className)} {...props} />
  ),
  ul: ({ className, ...props }) => (
    <ul className={cn("my-2 ml-6 list-disc", className)} {...props} />
  ),
  ol: ({ className, ...props }) => (
    <ol className={cn("my-2 ml-6 list-decimal", className)} {...props} />
  ),
  li: ({ className, ...props }) => (
    <li className={cn("my-1 leading-relaxed first:mt-0 last:mb-0", className)} {...props} />
  ),
  a: ({ className, ...props }) => (
    <a
      className={cn("underline underline-offset-2 hover:no-underline", className)}
      target="_blank"
      rel="noopener noreferrer"
      {...props}
    />
  ),
  blockquote: ({ className, ...props }) => (
    <blockquote
      className={cn("my-2 border-l-2 border-border pl-3 italic", className)}
      {...props}
    />
  ),
  // Style every <code> as inline (pill). The parent <pre> below nullifies the
  // pill for block code (```fenced``` or no-language fences) via a descendant
  // selector, so one ruleset handles both cases correctly. react-markdown v10
  // dropped the `inline` prop, and the className-based heuristic (`language-*`)
  // misclassifies fenced blocks that omit a language.
  code: ({ className, children, ...props }) => (
    <code
      className={cn(
        "rounded bg-background/60 px-1 py-0.5 font-mono text-[0.9em]",
        className,
      )}
      {...props}
    >
      {children}
    </code>
  ),
  pre: ({ className, ...props }) => (
    <pre
      className={cn(
        "my-2 overflow-x-auto rounded-md bg-background/60 p-3 text-sm leading-relaxed",
        "[&>code]:block [&>code]:bg-transparent [&>code]:p-0 [&>code]:text-sm",
        className,
      )}
      {...props}
    />
  ),
  table: ({ className, ...props }) => (
    <div className="my-2 overflow-x-auto">
      <table className={cn("w-full border-collapse text-sm", className)} {...props} />
    </div>
  ),
  th: ({ className, ...props }) => (
    <th
      className={cn("border border-border bg-background/40 px-2 py-1 text-left font-semibold", className)}
      {...props}
    />
  ),
  td: ({ className, ...props }) => (
    <td className={cn("border border-border px-2 py-1", className)} {...props} />
  ),
  hr: ({ className, ...props }) => (
    <hr className={cn("my-3 border-border", className)} {...props} />
  ),
};

export function Markdown({ children, className }: MarkdownProps) {
  return (
    <div className={cn("text-base leading-relaxed", className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {children}
      </ReactMarkdown>
    </div>
  );
}
