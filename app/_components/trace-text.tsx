import { Fragment } from "react";
import { traceSegments } from "./report";

/**
 * A trace cell's text: one line per line of the text, and a long path or event name that breaks only
 * after a "/" or a ".", never in the middle of an id. A <wbr> adds no character, so selected text
 * copies unchanged.
 */
export function TraceText({ text }: { text: string }) {
  return traceSegments(text).map((segments, line) => (
    <span key={line} className="block">
      {segments.map((segment, index) => (
        <Fragment key={index}>
          {segment}
          {index < segments.length - 1 && <wbr />}
        </Fragment>
      ))}
    </span>
  ));
}
