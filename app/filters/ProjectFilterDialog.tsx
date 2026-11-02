import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ProjectFilterEditor } from "./ProjectFilterEditor.js";

interface ProjectFilterDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAfterCloseAutoFocus: () => void;
}

export function ProjectFilterDialog({
  open,
  onOpenChange,
  onAfterCloseAutoFocus,
}: ProjectFilterDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-h-[85vh] overflow-y-auto sm:max-w-2xl"
        onAfterCloseAutoFocus={onAfterCloseAutoFocus}
      >
        <DialogHeader>
          <DialogTitle>Настроить фильтры</DialogTitle>
          <DialogDescription>
            Создавайте фильтры проектов и выбирайте правила отображения.
          </DialogDescription>
        </DialogHeader>
        <ProjectFilterEditor />
      </DialogContent>
    </Dialog>
  );
}
