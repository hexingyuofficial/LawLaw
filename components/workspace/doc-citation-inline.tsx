"use client";

import type { Ref } from "react";
import { BlockNoteSchema, defaultInlineContentSpecs } from "@blocknote/core/blocks";
import {
  createReactInlineContentSpec,
  InlineContentWrapper,
} from "@blocknote/react";

import { useOpenEvidenceFromPill } from "@/components/workspace/evidence-preview-bridge-context";

/**
 * 正文内「依据」药丸：存储为 docCitation，导出为 [doc:文件名]。
 */
export const docCitationInlineContentSpec = createReactInlineContentSpec(
  {
    type: "docCitation",
    propSchema: {
      sourceFile: { default: "", type: "string" },
    },
    content: "none",
  },
  {
    render: function DocCitationRender({ inlineContent, contentRef }) {
      const openEvidence = useOpenEvidenceFromPill();
      const name = (inlineContent.props.sourceFile || "").trim() || "来源";
      const short = name.length > 20 ? `${name.slice(0, 18)}…` : name;
      return (
        <InlineContentWrapper
          inlineContentType="docCitation"
          inlineContentProps={inlineContent.props}
          propSchema={{ sourceFile: { default: "", type: "string" } }}
        >
          <button
            ref={contentRef as Ref<HTMLButtonElement>}
            type="button"
            className="bn-inline-doc-citation mx-0.5 inline-flex max-w-[min(220px,45vw)] cursor-pointer align-middle border-0 bg-transparent p-0"
            title={`点击预览：${name}`}
            contentEditable={false}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => openEvidence(inlineContent.props.sourceFile || "")}
          >
            <span className="inline-flex items-center gap-0.5 rounded-full border border-emerald-200/90 bg-emerald-50 px-1.5 py-0 text-[10px] font-medium leading-tight text-emerald-900 shadow-sm transition hover:border-emerald-400 hover:bg-emerald-100">
              依据 · {short}
            </span>
          </button>
        </InlineContentWrapper>
      );
    },
    toExternalHTML: ({ inlineContent }) => {
      const f = (inlineContent.props.sourceFile || "").trim();
      return <span>{f ? `[doc:${f}]` : ""}</span>;
    },
  },
);

export const lawLawBlockNoteSchema = BlockNoteSchema.create({
  inlineContentSpecs: {
    ...defaultInlineContentSpecs,
    docCitation: docCitationInlineContentSpec,
  },
});
