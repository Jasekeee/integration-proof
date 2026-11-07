import { ResultsSkeleton } from "../_components/skeletons";

export default function Loading() {
  return <ResultsSkeleton columns={2} label="Loading the latest results" />;
}
