import { Get, JsonController } from "routing-controllers";

@JsonController("/dead")
export class DeadController {
  @Get()
  list(): string { return "not registered"; }
}
