import { ResultsSkeleton } from "../../_components/skeletons";

export default function Loading() {
  return <ResultsSkeleton columns={1} label="Loading this run" />;
}
