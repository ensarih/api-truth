import { Get, JsonController, Param } from "routing-controllers";

@JsonController("/pets")
export class PetController {
  @Get("/:id")
  one(@Param("id") id: string): string { return id; }
}
